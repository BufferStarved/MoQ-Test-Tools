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
cmake_pop_check_state()

add_executable(moq5-fmp4-publish main.c)
target_link_libraries(moq5-fmp4-publish PRIVATE moq::service)
target_compile_definitions(moq5-fmp4-publish PRIVATE
  MOQ5_HAVE_SIZED_SENDER_CFG_INIT=$<BOOL:${MOQ5_HAVE_SIZED_SENDER_CFG_INIT}>)

if(CMAKE_C_COMPILER_ID MATCHES "Clang|GNU")
  target_compile_options(moq5-fmp4-publish PRIVATE
    -Wall -Wextra -Wpedantic)
endif()

include(CTest)
if(BUILD_TESTING)
  find_program(FFMPEG_EXECUTABLE ffmpeg)
  if(FFMPEG_EXECUTABLE)
    add_executable(moq5-fmp4-publish-test test_multitrack.c)
    target_link_libraries(moq5-fmp4-publish-test PRIVATE moq::service)
    target_compile_definitions(moq5-fmp4-publish-test PRIVATE
      MOQ5_HAVE_SIZED_SENDER_CFG_INIT=$<BOOL:${MOQ5_HAVE_SIZED_SENDER_CFG_INIT}>)
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
  else()
    message(STATUS "ffmpeg not found: multitrack publisher test disabled")
  endif()
endif()

install(TARGETS moq5-fmp4-publish RUNTIME DESTINATION bin)
