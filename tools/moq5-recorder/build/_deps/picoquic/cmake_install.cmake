# Install script for directory: /Users/sean/Developer/moq-test-tools/tools/deps/picoquic

# Set the install prefix
if(NOT DEFINED CMAKE_INSTALL_PREFIX)
  set(CMAKE_INSTALL_PREFIX "/usr/local")
endif()
string(REGEX REPLACE "/$" "" CMAKE_INSTALL_PREFIX "${CMAKE_INSTALL_PREFIX}")

# Set the install configuration name.
if(NOT DEFINED CMAKE_INSTALL_CONFIG_NAME)
  if(BUILD_TYPE)
    string(REGEX REPLACE "^[^A-Za-z0-9_]+" ""
           CMAKE_INSTALL_CONFIG_NAME "${BUILD_TYPE}")
  else()
    set(CMAKE_INSTALL_CONFIG_NAME "Release")
  endif()
  message(STATUS "Install configuration: \"${CMAKE_INSTALL_CONFIG_NAME}\"")
endif()

# Set the component getting installed.
if(NOT CMAKE_INSTALL_COMPONENT)
  if(COMPONENT)
    message(STATUS "Install component: \"${COMPONENT}\"")
    set(CMAKE_INSTALL_COMPONENT "${COMPONENT}")
  else()
    set(CMAKE_INSTALL_COMPONENT)
  endif()
endif()

# Is this installation the result of a crosscompile?
if(NOT DEFINED CMAKE_CROSSCOMPILING)
  set(CMAKE_CROSSCOMPILING "FALSE")
endif()

# Set path to fallback-tool for dependency-resolution.
if(NOT DEFINED CMAKE_OBJDUMP)
  set(CMAKE_OBJDUMP "/usr/bin/objdump")
endif()

if(CMAKE_INSTALL_COMPONENT STREQUAL "Unspecified" OR NOT CMAKE_INSTALL_COMPONENT)
  list(APPEND CMAKE_ABSOLUTE_DESTINATION_FILES
   "/usr/local/lib/libpicohttp-core.a")
  if(CMAKE_WARN_ON_ABSOLUTE_INSTALL_DESTINATION)
    message(WARNING "ABSOLUTE path INSTALL DESTINATION : ${CMAKE_ABSOLUTE_DESTINATION_FILES}")
  endif()
  if(CMAKE_ERROR_ON_ABSOLUTE_INSTALL_DESTINATION)
    message(FATAL_ERROR "ABSOLUTE path INSTALL DESTINATION forbidden (by caller): ${CMAKE_ABSOLUTE_DESTINATION_FILES}")
  endif()
  file(INSTALL DESTINATION "/usr/local/lib" TYPE STATIC_LIBRARY FILES "/Users/sean/Developer/moq-test-tools/tools/moq5-recorder/build/_deps/picoquic/libpicohttp-core.a")
  if(EXISTS "$ENV{DESTDIR}/usr/local/lib/libpicohttp-core.a" AND
     NOT IS_SYMLINK "$ENV{DESTDIR}/usr/local/lib/libpicohttp-core.a")
    execute_process(COMMAND "/usr/bin/ranlib" "$ENV{DESTDIR}/usr/local/lib/libpicohttp-core.a")
  endif()
endif()

if(CMAKE_INSTALL_COMPONENT STREQUAL "Unspecified" OR NOT CMAKE_INSTALL_COMPONENT)
  list(APPEND CMAKE_ABSOLUTE_DESTINATION_FILES
   "/usr/local/include/picosplay.h;/usr/local/include/h3zero.h;/usr/local/include/h3zero_common.h;/usr/local/include/h3zero_uri.h;/usr/local/include/h3zero_url_template.h;/usr/local/include/democlient.h;/usr/local/include/demoserver.h;/usr/local/include/pico_webtransport.h;/usr/local/include/picoquic_ns.h;/usr/local/include/picomask.h")
  if(CMAKE_WARN_ON_ABSOLUTE_INSTALL_DESTINATION)
    message(WARNING "ABSOLUTE path INSTALL DESTINATION : ${CMAKE_ABSOLUTE_DESTINATION_FILES}")
  endif()
  if(CMAKE_ERROR_ON_ABSOLUTE_INSTALL_DESTINATION)
    message(FATAL_ERROR "ABSOLUTE path INSTALL DESTINATION forbidden (by caller): ${CMAKE_ABSOLUTE_DESTINATION_FILES}")
  endif()
  file(INSTALL DESTINATION "/usr/local/include" TYPE FILE FILES
    "/Users/sean/Developer/moq-test-tools/tools/deps/picoquic/picoquic/picosplay.h"
    "/Users/sean/Developer/moq-test-tools/tools/deps/picoquic/picohttp/h3zero.h"
    "/Users/sean/Developer/moq-test-tools/tools/deps/picoquic/picohttp/h3zero_common.h"
    "/Users/sean/Developer/moq-test-tools/tools/deps/picoquic/picohttp/h3zero_uri.h"
    "/Users/sean/Developer/moq-test-tools/tools/deps/picoquic/picohttp/h3zero_url_template.h"
    "/Users/sean/Developer/moq-test-tools/tools/deps/picoquic/picohttp/democlient.h"
    "/Users/sean/Developer/moq-test-tools/tools/deps/picoquic/picohttp/demoserver.h"
    "/Users/sean/Developer/moq-test-tools/tools/deps/picoquic/picohttp/pico_webtransport.h"
    "/Users/sean/Developer/moq-test-tools/tools/deps/picoquic/picohttp/picoquic_ns.h"
    "/Users/sean/Developer/moq-test-tools/tools/deps/picoquic/picohttp/picomask.h"
    )
endif()

if(CMAKE_INSTALL_COMPONENT STREQUAL "Unspecified" OR NOT CMAKE_INSTALL_COMPONENT)
  list(APPEND CMAKE_ABSOLUTE_DESTINATION_FILES
   "/usr/local/bin/picolog_t")
  if(CMAKE_WARN_ON_ABSOLUTE_INSTALL_DESTINATION)
    message(WARNING "ABSOLUTE path INSTALL DESTINATION : ${CMAKE_ABSOLUTE_DESTINATION_FILES}")
  endif()
  if(CMAKE_ERROR_ON_ABSOLUTE_INSTALL_DESTINATION)
    message(FATAL_ERROR "ABSOLUTE path INSTALL DESTINATION forbidden (by caller): ${CMAKE_ABSOLUTE_DESTINATION_FILES}")
  endif()
  file(INSTALL DESTINATION "/usr/local/bin" TYPE EXECUTABLE FILES "/Users/sean/Developer/moq-test-tools/tools/moq5-recorder/build/_deps/picoquic/picolog_t")
  if(EXISTS "$ENV{DESTDIR}/usr/local/bin/picolog_t" AND
     NOT IS_SYMLINK "$ENV{DESTDIR}/usr/local/bin/picolog_t")
    if(CMAKE_INSTALL_DO_STRIP)
      execute_process(COMMAND "/usr/bin/strip" -u -r "$ENV{DESTDIR}/usr/local/bin/picolog_t")
    endif()
  endif()
endif()

if(CMAKE_INSTALL_COMPONENT STREQUAL "Unspecified" OR NOT CMAKE_INSTALL_COMPONENT)
  list(APPEND CMAKE_ABSOLUTE_DESTINATION_FILES
   "/usr/local/lib/libpicoquic-log.a")
  if(CMAKE_WARN_ON_ABSOLUTE_INSTALL_DESTINATION)
    message(WARNING "ABSOLUTE path INSTALL DESTINATION : ${CMAKE_ABSOLUTE_DESTINATION_FILES}")
  endif()
  if(CMAKE_ERROR_ON_ABSOLUTE_INSTALL_DESTINATION)
    message(FATAL_ERROR "ABSOLUTE path INSTALL DESTINATION forbidden (by caller): ${CMAKE_ABSOLUTE_DESTINATION_FILES}")
  endif()
  file(INSTALL DESTINATION "/usr/local/lib" TYPE STATIC_LIBRARY FILES "/Users/sean/Developer/moq-test-tools/tools/moq5-recorder/build/_deps/picoquic/libpicoquic-log.a")
  if(EXISTS "$ENV{DESTDIR}/usr/local/lib/libpicoquic-log.a" AND
     NOT IS_SYMLINK "$ENV{DESTDIR}/usr/local/lib/libpicoquic-log.a")
    execute_process(COMMAND "/usr/bin/ranlib" "$ENV{DESTDIR}/usr/local/lib/libpicoquic-log.a")
  endif()
endif()

if(CMAKE_INSTALL_COMPONENT STREQUAL "Unspecified" OR NOT CMAKE_INSTALL_COMPONENT)
  list(APPEND CMAKE_ABSOLUTE_DESTINATION_FILES
   "/usr/local/include/autoqlog.h;/usr/local/include/auto_memlog.h")
  if(CMAKE_WARN_ON_ABSOLUTE_INSTALL_DESTINATION)
    message(WARNING "ABSOLUTE path INSTALL DESTINATION : ${CMAKE_ABSOLUTE_DESTINATION_FILES}")
  endif()
  if(CMAKE_ERROR_ON_ABSOLUTE_INSTALL_DESTINATION)
    message(FATAL_ERROR "ABSOLUTE path INSTALL DESTINATION forbidden (by caller): ${CMAKE_ABSOLUTE_DESTINATION_FILES}")
  endif()
  file(INSTALL DESTINATION "/usr/local/include" TYPE FILE FILES
    "/Users/sean/Developer/moq-test-tools/tools/deps/picoquic/loglib/autoqlog.h"
    "/Users/sean/Developer/moq-test-tools/tools/deps/picoquic/loglib/auto_memlog.h"
    )
endif()

if(CMAKE_INSTALL_COMPONENT STREQUAL "Unspecified" OR NOT CMAKE_INSTALL_COMPONENT)
  list(APPEND CMAKE_ABSOLUTE_DESTINATION_FILES
   "/usr/local/lib/libpicoquic-core.a")
  if(CMAKE_WARN_ON_ABSOLUTE_INSTALL_DESTINATION)
    message(WARNING "ABSOLUTE path INSTALL DESTINATION : ${CMAKE_ABSOLUTE_DESTINATION_FILES}")
  endif()
  if(CMAKE_ERROR_ON_ABSOLUTE_INSTALL_DESTINATION)
    message(FATAL_ERROR "ABSOLUTE path INSTALL DESTINATION forbidden (by caller): ${CMAKE_ABSOLUTE_DESTINATION_FILES}")
  endif()
  file(INSTALL DESTINATION "/usr/local/lib" TYPE STATIC_LIBRARY FILES "/Users/sean/Developer/moq-test-tools/tools/moq5-recorder/build/_deps/picoquic/libpicoquic-core.a")
  if(EXISTS "$ENV{DESTDIR}/usr/local/lib/libpicoquic-core.a" AND
     NOT IS_SYMLINK "$ENV{DESTDIR}/usr/local/lib/libpicoquic-core.a")
    execute_process(COMMAND "/usr/bin/ranlib" "$ENV{DESTDIR}/usr/local/lib/libpicoquic-core.a")
  endif()
endif()

if(CMAKE_INSTALL_COMPONENT STREQUAL "Unspecified" OR NOT CMAKE_INSTALL_COMPONENT)
  if(EXISTS "$ENV{DESTDIR}/usr/local/lib/cmake/picoquic/picoquic-targets.cmake")
    file(DIFFERENT _cmake_export_file_changed FILES
         "$ENV{DESTDIR}/usr/local/lib/cmake/picoquic/picoquic-targets.cmake"
         "/Users/sean/Developer/moq-test-tools/tools/moq5-recorder/build/_deps/picoquic/CMakeFiles/Export/47d678a933dee9f980aca86079cf6c94/picoquic-targets.cmake")
    if(_cmake_export_file_changed)
      file(GLOB _cmake_old_config_files "$ENV{DESTDIR}/usr/local/lib/cmake/picoquic/picoquic-targets-*.cmake")
      if(_cmake_old_config_files)
        string(REPLACE ";" ", " _cmake_old_config_files_text "${_cmake_old_config_files}")
        message(STATUS "Old export file \"$ENV{DESTDIR}/usr/local/lib/cmake/picoquic/picoquic-targets.cmake\" will be replaced.  Removing files [${_cmake_old_config_files_text}].")
        unset(_cmake_old_config_files_text)
        file(REMOVE ${_cmake_old_config_files})
      endif()
      unset(_cmake_old_config_files)
    endif()
    unset(_cmake_export_file_changed)
  endif()
  list(APPEND CMAKE_ABSOLUTE_DESTINATION_FILES
   "/usr/local/lib/cmake/picoquic/picoquic-targets.cmake")
  if(CMAKE_WARN_ON_ABSOLUTE_INSTALL_DESTINATION)
    message(WARNING "ABSOLUTE path INSTALL DESTINATION : ${CMAKE_ABSOLUTE_DESTINATION_FILES}")
  endif()
  if(CMAKE_ERROR_ON_ABSOLUTE_INSTALL_DESTINATION)
    message(FATAL_ERROR "ABSOLUTE path INSTALL DESTINATION forbidden (by caller): ${CMAKE_ABSOLUTE_DESTINATION_FILES}")
  endif()
  file(INSTALL DESTINATION "/usr/local/lib/cmake/picoquic" TYPE FILE FILES "/Users/sean/Developer/moq-test-tools/tools/moq5-recorder/build/_deps/picoquic/CMakeFiles/Export/47d678a933dee9f980aca86079cf6c94/picoquic-targets.cmake")
  if(CMAKE_INSTALL_CONFIG_NAME MATCHES "^([Rr][Ee][Ll][Ee][Aa][Ss][Ee])$")
    list(APPEND CMAKE_ABSOLUTE_DESTINATION_FILES
     "/usr/local/lib/cmake/picoquic/picoquic-targets-release.cmake")
    if(CMAKE_WARN_ON_ABSOLUTE_INSTALL_DESTINATION)
      message(WARNING "ABSOLUTE path INSTALL DESTINATION : ${CMAKE_ABSOLUTE_DESTINATION_FILES}")
    endif()
    if(CMAKE_ERROR_ON_ABSOLUTE_INSTALL_DESTINATION)
      message(FATAL_ERROR "ABSOLUTE path INSTALL DESTINATION forbidden (by caller): ${CMAKE_ABSOLUTE_DESTINATION_FILES}")
    endif()
    file(INSTALL DESTINATION "/usr/local/lib/cmake/picoquic" TYPE FILE FILES "/Users/sean/Developer/moq-test-tools/tools/moq5-recorder/build/_deps/picoquic/CMakeFiles/Export/47d678a933dee9f980aca86079cf6c94/picoquic-targets-release.cmake")
  endif()
endif()

if(CMAKE_INSTALL_COMPONENT STREQUAL "Unspecified" OR NOT CMAKE_INSTALL_COMPONENT)
  list(APPEND CMAKE_ABSOLUTE_DESTINATION_FILES
   "/usr/local/include/picoquic.h;/usr/local/include/picosocks.h;/usr/local/include/picoquic_utils.h;/usr/local/include/picoquic_packet_loop.h;/usr/local/include/picoquic_config.h;/usr/local/include/picoquic_lb.h;/usr/local/include/picoquic_newreno.h;/usr/local/include/picoquic_cubic.h;/usr/local/include/picoquic_bbr.h;/usr/local/include/picoquic_bbr1.h;/usr/local/include/picoquictest_dualq.h;/usr/local/include/picoquic_fastcc.h;/usr/local/include/picoquic_prague.h;/usr/local/include/picoquic_qlog.h;/usr/local/include/c4.h;/usr/local/include/siphash.h")
  if(CMAKE_WARN_ON_ABSOLUTE_INSTALL_DESTINATION)
    message(WARNING "ABSOLUTE path INSTALL DESTINATION : ${CMAKE_ABSOLUTE_DESTINATION_FILES}")
  endif()
  if(CMAKE_ERROR_ON_ABSOLUTE_INSTALL_DESTINATION)
    message(FATAL_ERROR "ABSOLUTE path INSTALL DESTINATION forbidden (by caller): ${CMAKE_ABSOLUTE_DESTINATION_FILES}")
  endif()
  file(INSTALL DESTINATION "/usr/local/include" TYPE FILE FILES
    "/Users/sean/Developer/moq-test-tools/tools/deps/picoquic/picoquic/picoquic.h"
    "/Users/sean/Developer/moq-test-tools/tools/deps/picoquic/picoquic/picosocks.h"
    "/Users/sean/Developer/moq-test-tools/tools/deps/picoquic/picoquic/picoquic_utils.h"
    "/Users/sean/Developer/moq-test-tools/tools/deps/picoquic/picoquic/picoquic_packet_loop.h"
    "/Users/sean/Developer/moq-test-tools/tools/deps/picoquic/picoquic/picoquic_config.h"
    "/Users/sean/Developer/moq-test-tools/tools/deps/picoquic/picoquic/picoquic_lb.h"
    "/Users/sean/Developer/moq-test-tools/tools/deps/picoquic/picoquic/picoquic_newreno.h"
    "/Users/sean/Developer/moq-test-tools/tools/deps/picoquic/picoquic/picoquic_cubic.h"
    "/Users/sean/Developer/moq-test-tools/tools/deps/picoquic/picoquic/picoquic_bbr.h"
    "/Users/sean/Developer/moq-test-tools/tools/deps/picoquic/picoquic/picoquic_bbr1.h"
    "/Users/sean/Developer/moq-test-tools/tools/deps/picoquic/picoquic/picoquictest_dualq.h"
    "/Users/sean/Developer/moq-test-tools/tools/deps/picoquic/picoquic/picoquic_fastcc.h"
    "/Users/sean/Developer/moq-test-tools/tools/deps/picoquic/picoquic/picoquic_prague.h"
    "/Users/sean/Developer/moq-test-tools/tools/deps/picoquic/picoquic/picoquic_qlog.h"
    "/Users/sean/Developer/moq-test-tools/tools/deps/picoquic/picoquic/c4.h"
    "/Users/sean/Developer/moq-test-tools/tools/deps/picoquic/picoquic/siphash.h"
    )
endif()

if(CMAKE_INSTALL_COMPONENT STREQUAL "Unspecified" OR NOT CMAKE_INSTALL_COMPONENT)
  list(APPEND CMAKE_ABSOLUTE_DESTINATION_FILES
   "/usr/local/lib/cmake/picoquic/picoquic-config.cmake;/usr/local/lib/cmake/picoquic/picoquic-config-version.cmake")
  if(CMAKE_WARN_ON_ABSOLUTE_INSTALL_DESTINATION)
    message(WARNING "ABSOLUTE path INSTALL DESTINATION : ${CMAKE_ABSOLUTE_DESTINATION_FILES}")
  endif()
  if(CMAKE_ERROR_ON_ABSOLUTE_INSTALL_DESTINATION)
    message(FATAL_ERROR "ABSOLUTE path INSTALL DESTINATION forbidden (by caller): ${CMAKE_ABSOLUTE_DESTINATION_FILES}")
  endif()
  file(INSTALL DESTINATION "/usr/local/lib/cmake/picoquic" TYPE FILE FILES
    "/Users/sean/Developer/moq-test-tools/tools/moq5-recorder/build/_deps/picoquic/picoquic-config.cmake"
    "/Users/sean/Developer/moq-test-tools/tools/moq5-recorder/build/_deps/picoquic/picoquic-config-version.cmake"
    )
endif()

string(REPLACE ";" "\n" CMAKE_INSTALL_MANIFEST_CONTENT
       "${CMAKE_INSTALL_MANIFEST_FILES}")
if(CMAKE_INSTALL_LOCAL_ONLY)
  file(WRITE "/Users/sean/Developer/moq-test-tools/tools/moq5-recorder/build/_deps/picoquic/install_local_manifest.txt"
     "${CMAKE_INSTALL_MANIFEST_CONTENT}")
endif()
