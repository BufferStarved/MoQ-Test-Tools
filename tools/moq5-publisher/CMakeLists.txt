cmake_minimum_required(VERSION 3.20)
project(moq5_fmp4_publish C)

set(CMAKE_C_STANDARD 11)
set(CMAKE_C_STANDARD_REQUIRED ON)

if(NOT MOQ5_PREFIX)
  set(MOQ5_PREFIX "$ENV{MOQ5_PREFIX}")
endif()
if(NOT MOQ5_PREFIX)
  message(FATAL_ERROR "Set MOQ5_PREFIX to the moq5 cmake install prefix (tools/moq5/install)")
endif()

list(APPEND CMAKE_PREFIX_PATH "${MOQ5_PREFIX}")
list(APPEND CMAKE_MODULE_PATH "${MOQ5_PREFIX}/lib/cmake/libmoq")

# Installed libmoq service links the WebTransport adapter, which expects the
# picoquic source-tree targets (picoquic::picohttp-core) to exist.
if(MOQ_PICOQUIC_SOURCE_DIR)
  set(MOQ_BUILD_ADAPTER_PICOQUIC ON CACHE BOOL "" FORCE)
  set(MOQ_BUILD_ADAPTER_PICO_WT ON CACHE BOOL "" FORCE)
  set(MOQ_BUILD_PICO_WT_MANAGED ON CACHE BOOL "" FORCE)
  find_package(Picoquic MODULE REQUIRED)
endif()

find_package(libmoq REQUIRED COMPONENTS service)

include(CheckCSourceCompiles)
include(CMakePushCheckState)
# Only the declaration matters here, so this compiles without linking: pulling
# moq::service into a try_compile would re-import its transport dependencies
# (picoquic::*), which are not defined inside the scratch project.
get_target_property(MOQ5_SERVICE_INCLUDES moq::service
  INTERFACE_INCLUDE_DIRECTORIES)
cmake_push_check_state(RESET)
if(MOQ5_SERVICE_INCLUDES)
  set(CMAKE_REQUIRED_INCLUDES ${MOQ5_SERVICE_INCLUDES})
endif()
# Build a static library so the check stops after compiling: the declaration is
# what matters, and linking would need moq::service (and its transports) here.
set(CMAKE_TRY_COMPILE_TARGET_TYPE STATIC_LIBRARY)
set(CMAKE_REQUIRED_FLAGS "-Werror=implicit-function-declaration")
check_c_source_compiles([=[
  #include <moq/media_sender.h>
  int main(void) {
    moq_media_sender_cfg_t cfg;
    moq_media_sender_cfg_init_live_sized(&cfg, sizeof(cfg));
    return 0;
  }
]=] MOQ5_HAVE_SIZED_SENDER_CFG_INIT)
check_c_source_compiles([=[
  #include <moq/media_sender.h>
  int main(void) {
    moq_media_sender_cfg_t cfg;
    moq_media_sender_cfg_init_live(&cfg);
    cfg.publish_tracks = 1;
    return cfg.publish_tracks ? 0 : 1;
  }
]=] MOQ5_HAVE_PUBLISH_TRACKS)
cmake_pop_check_state()

set(MOQ5_BRIDGE_DEFS
  MOQ5_HAVE_SIZED_SENDER_CFG_INIT=$<BOOL:${MOQ5_HAVE_SIZED_SENDER_CFG_INIT}>
  MOQ5_HAVE_PUBLISH_TRACKS=$<BOOL:${MOQ5_HAVE_PUBLISH_TRACKS}>)

add_library(fmp4_moq STATIC fmp4_moq_bridge.c)
target_include_directories(fmp4_moq PUBLIC "${CMAKE_CURRENT_SOURCE_DIR}")
target_link_libraries(fmp4_moq PUBLIC moq::service)
target_compile_definitions(fmp4_moq PRIVATE ${MOQ5_BRIDGE_DEFS})

set(THREADS_PREFER_PTHREAD_FLAG ON)
find_package(Threads REQUIRED)

add_executable(moq5-fmp4-publish main.c)
target_link_libraries(moq5-fmp4-publish PRIVATE fmp4_moq Threads::Threads)

add_executable(moq_link_spike moq_link_spike.c)
target_link_libraries(moq_link_spike PRIVATE fmp4_moq)

find_package(PkgConfig)
if(PkgConfig_FOUND)
  pkg_check_modules(LIBAV IMPORTED_TARGET libavformat libavcodec libavutil)
endif()
if(TARGET PkgConfig::LIBAV)
  add_executable(ffmoq "${CMAKE_CURRENT_SOURCE_DIR}/../ffmpeg-moq/ffmoq.c")
  target_link_libraries(ffmoq PRIVATE fmp4_moq PkgConfig::LIBAV)
  if(CMAKE_C_COMPILER_ID MATCHES "Clang|GNU")
    target_compile_options(ffmoq PRIVATE -Wall -Wextra -Wpedantic)
  endif()
  message(STATUS "ffmoq: libavformat native publisher enabled")
else()
  message(STATUS "ffmoq: skipped (pkg-config libavformat not found)")
endif()

if(CMAKE_C_COMPILER_ID MATCHES "Clang|GNU")
  foreach(tgt fmp4_moq moq5-fmp4-publish moq_link_spike)
    target_compile_options(${tgt} PRIVATE -Wall -Wextra -Wpedantic)
  endforeach()
endif()

include(CTest)
if(BUILD_TESTING)
  find_program(FFMPEG_EXECUTABLE ffmpeg)
  if(FFMPEG_EXECUTABLE)
    add_executable(moq5-fmp4-publish-test test_multitrack.c)
    target_link_libraries(moq5-fmp4-publish-test PRIVATE fmp4_moq)
    target_compile_definitions(moq5-fmp4-publish-test PRIVATE ${MOQ5_BRIDGE_DEFS})
    if(CMAKE_C_COMPILER_ID MATCHES "Clang|GNU")
      target_compile_options(moq5-fmp4-publish-test PRIVATE
        -Wall -Wextra -Wpedantic)
    endif()

    set(MOQ5_MULTITRACK_FIXTURE
      "${CMAKE_CURRENT_BINARY_DIR}/moq5-multitrack-fixture.mp4")
    set(MOQ5_INTERLEAVED_FIXTURE
      "${CMAKE_CURRENT_BINARY_DIR}/moq5-interleaved-fixture.mp4")
    add_test(NAME moq5-fmp4-generate-multitrack-fixture
      COMMAND "${FFMPEG_EXECUTABLE}"
        -hide_banner -loglevel error -y
        -f lavfi -i testsrc=size=64x64:rate=2
        -f lavfi -i sine=frequency=1000:sample_rate=48000
        -t 1 -map 0:v:0 -map 1:a:0
        -c:v libx264 -preset ultrafast -pix_fmt yuv420p
        -g 2 -keyint_min 2 -sc_threshold 0
        -c:a aac -b:a 64k
        -movflags +frag_keyframe+empty_moov+default_base_moof+separate_moof
        -f mp4 "${MOQ5_MULTITRACK_FIXTURE}")
    set_tests_properties(moq5-fmp4-generate-multitrack-fixture PROPERTIES
      FIXTURES_SETUP moq5_multitrack TIMEOUT 30)

    add_test(NAME moq5-fmp4-generate-interleaved-fixture
      COMMAND "${FFMPEG_EXECUTABLE}"
        -hide_banner -loglevel error -y
        -f lavfi -i testsrc=size=64x64:rate=2
        -f lavfi -i sine=frequency=1000:sample_rate=48000
        -t 1 -map 0:v:0 -map 1:a:0
        -c:v libx264 -preset ultrafast -pix_fmt yuv420p
        -g 2 -keyint_min 2 -sc_threshold 0
        -c:a aac -b:a 64k
        -movflags +frag_keyframe+empty_moov+default_base_moof
        -f mp4 "${MOQ5_INTERLEAVED_FIXTURE}")
    set_tests_properties(moq5-fmp4-generate-interleaved-fixture PROPERTIES
      FIXTURES_SETUP moq5_multitrack TIMEOUT 30)

    add_test(NAME moq5-fmp4-multitrack
      COMMAND moq5-fmp4-publish-test
        "${MOQ5_MULTITRACK_FIXTURE}" "${MOQ5_INTERLEAVED_FIXTURE}")
    set_tests_properties(moq5-fmp4-multitrack PROPERTIES
      FIXTURES_REQUIRED moq5_multitrack TIMEOUT 10)

    # libmoq connect is asynchronous: a dead URL still returns a sender, so
    # this exercises connect + fixture feed + close without a live relay.
    add_test(NAME moq-link-spike-fixture
      COMMAND moq_link_spike
        "https://127.0.0.1:1/moq-relay" spike-test
        "${MOQ5_MULTITRACK_FIXTURE}")
    set_tests_properties(moq-link-spike-fixture PROPERTIES
      FIXTURES_REQUIRED moq5_multitrack
      PASS_REGULAR_EXPRESSION "published fixture"
      TIMEOUT 15)

    if(TARGET ffmoq)
      add_test(NAME ffmoq-remux-fixture
        COMMAND ffmoq
          "https://127.0.0.1:1/moq-relay" spike-ffmoq
          "${MOQ5_MULTITRACK_FIXTURE}")
      set_tests_properties(ffmoq-remux-fixture PROPERTIES
        FIXTURES_REQUIRED moq5_multitrack
        PASS_REGULAR_EXPRESSION "ffmoq: published"
        TIMEOUT 20)
    endif()
  else()
    message(STATUS "ffmpeg not found: multitrack publisher test disabled")
  endif()
endif()

install(TARGETS moq5-fmp4-publish moq_link_spike RUNTIME DESTINATION bin)
if(TARGET ffmoq)
  install(TARGETS ffmoq RUNTIME DESTINATION bin)
endif()
install(TARGETS fmp4_moq ARCHIVE DESTINATION lib)
install(FILES fmp4_moq_bridge.h DESTINATION include)
