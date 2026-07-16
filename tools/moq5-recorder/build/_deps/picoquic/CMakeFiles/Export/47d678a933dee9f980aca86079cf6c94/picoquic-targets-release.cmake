#----------------------------------------------------------------
# Generated CMake target import file for configuration "Release".
#----------------------------------------------------------------

# Commands may need to know the format version.
set(CMAKE_IMPORT_FILE_VERSION 1)

# Import target "picoquic::picohttp-core" for configuration "Release"
set_property(TARGET picoquic::picohttp-core APPEND PROPERTY IMPORTED_CONFIGURATIONS RELEASE)
set_target_properties(picoquic::picohttp-core PROPERTIES
  IMPORTED_LINK_INTERFACE_LANGUAGES_RELEASE "C"
  IMPORTED_LOCATION_RELEASE "/usr/local/lib/libpicohttp-core.a"
  )

list(APPEND _cmake_import_check_targets picoquic::picohttp-core )
list(APPEND _cmake_import_check_files_for_picoquic::picohttp-core "/usr/local/lib/libpicohttp-core.a" )

# Import target "picoquic::picoquic-log" for configuration "Release"
set_property(TARGET picoquic::picoquic-log APPEND PROPERTY IMPORTED_CONFIGURATIONS RELEASE)
set_target_properties(picoquic::picoquic-log PROPERTIES
  IMPORTED_LINK_INTERFACE_LANGUAGES_RELEASE "C"
  IMPORTED_LOCATION_RELEASE "/usr/local/lib/libpicoquic-log.a"
  )

list(APPEND _cmake_import_check_targets picoquic::picoquic-log )
list(APPEND _cmake_import_check_files_for_picoquic::picoquic-log "/usr/local/lib/libpicoquic-log.a" )

# Import target "picoquic::picoquic-core" for configuration "Release"
set_property(TARGET picoquic::picoquic-core APPEND PROPERTY IMPORTED_CONFIGURATIONS RELEASE)
set_target_properties(picoquic::picoquic-core PROPERTIES
  IMPORTED_LINK_INTERFACE_LANGUAGES_RELEASE "C"
  IMPORTED_LOCATION_RELEASE "/usr/local/lib/libpicoquic-core.a"
  )

list(APPEND _cmake_import_check_targets picoquic::picoquic-core )
list(APPEND _cmake_import_check_files_for_picoquic::picoquic-core "/usr/local/lib/libpicoquic-core.a" )

# Commands beyond this point should not need to know the version.
set(CMAKE_IMPORT_FILE_VERSION)
