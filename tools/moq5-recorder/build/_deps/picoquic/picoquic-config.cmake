
####### Expanded from @PACKAGE_INIT@ by configure_package_config_file() #######
####### Any changes to this file will be overwritten by the next CMake run ####
####### The input file was picoquic-config.cmake.in                            ########

get_filename_component(PACKAGE_PREFIX_DIR "${CMAKE_CURRENT_LIST_DIR}/../../../" ABSOLUTE)

macro(set_and_check _var _file)
  set(${_var} "${_file}")
  if(NOT EXISTS "${_file}")
    message(FATAL_ERROR "File or directory ${_file} referenced by variable ${_var} does not exist !")
  endif()
endmacro()

macro(check_required_components _NAME)
  foreach(comp ${${_NAME}_FIND_COMPONENTS})
    if(NOT ${_NAME}_${comp}_FOUND)
      if(${_NAME}_FIND_REQUIRED_${comp})
        set(${_NAME}_FOUND FALSE)
      endif()
    endif()
  endforeach()
endmacro()

####################################################################################

include(CMakeFindDependencyMacro)
if(ON)
    find_dependency(Threads)
endif()
if(ON)
    find_dependency(OpenSSL)
endif()

include("${CMAKE_CURRENT_LIST_DIR}/picoquic-targets.cmake")

set(picoquic_VERSION "${PACKAGE_PREFIX_DIR}/0.0.0-9ee0a66")
set(picoquic_LIBRARIES "${PACKAGE_PREFIX_DIR}/lib/libpicoquic-core.a")
set(picoquic_INCLUDE_DIR "${PACKAGE_PREFIX_DIR}/include")

check_required_components(picoquic)
