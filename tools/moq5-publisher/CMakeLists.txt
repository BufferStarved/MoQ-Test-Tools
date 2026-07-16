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

add_executable(moq5-fmp4-publish main.c)
target_link_libraries(moq5-fmp4-publish PRIVATE moq::service)
install(TARGETS moq5-fmp4-publish RUNTIME DESTINATION bin)
