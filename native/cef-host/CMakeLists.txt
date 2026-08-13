cmake_minimum_required(VERSION 3.21)
project(ufo_cef_host)

set(CMAKE_CONFIGURATION_TYPES Debug Release)
set(CEF_ROOT "${CEF_ROOT}" CACHE PATH "CEF binary distribution root")
if(NOT CEF_ROOT)
  set(CEF_ROOT "$ENV{UFO_CEF_ROOT}" CACHE PATH "CEF binary distribution root")
endif()
if(NOT CEF_ROOT)
  message(FATAL_ERROR "Set UFO_CEF_ROOT to a CEF binary distribution")
endif()
set(CMAKE_MODULE_PATH ${CMAKE_MODULE_PATH} "${CEF_ROOT}/cmake")
find_package(CEF REQUIRED)

add_subdirectory(${CEF_LIBCEF_DLL_WRAPPER_PATH} libcef_dll_wrapper)

set(CEF_TARGET "ufo-cef-host")
set(CEF_HELPER_TARGET "ufo-cef-host_Helper")
set(CEF_HELPER_OUTPUT_NAME "ufo-cef-host Helper")
if(GEN_NINJA OR GEN_MAKEFILES)
  # CEF's macOS bundle targets are emitted directly into the binary directory
  # with Ninja/Make. Keep the framework and helper copy destinations aligned
  # with the actual bundle location rather than a configuration subdirectory.
  set(CEF_TARGET_OUT_DIR "${CMAKE_CURRENT_BINARY_DIR}")
elseif(NOT CEF_TARGET_OUT_DIR)
  set(CEF_TARGET_OUT_DIR "${CMAKE_CURRENT_BINARY_DIR}/$<CONFIGURATION>")
endif()
set(CEF_APP "${CEF_TARGET_OUT_DIR}/${CEF_TARGET}.app")

set(CEF_HOST_SRCS
  app.cc
  handler.cc
  main_mac.mm
  overlay_mac.mm
)
set(CEF_HELPER_SRCS process_helper_mac.cc)
set(CEF_LAUNCHER_SRCS native-launcher.mm)

set(EXECUTABLE_NAME "${CEF_TARGET}")
set(PRODUCT_NAME "UFO-Browser Native Chrome")
set(VERSION_SHORT "${UFO_PRODUCT_VERSION}")
if(NOT UFO_PRODUCT_VERSION)
  set(VERSION_SHORT "0.1.7")
endif()

add_executable(${CEF_TARGET} MACOSX_BUNDLE ${CEF_HOST_SRCS})
SET_EXECUTABLE_TARGET_PROPERTIES(${CEF_TARGET})
target_include_directories(${CEF_TARGET} PRIVATE "${CMAKE_CURRENT_SOURCE_DIR}/../..")
target_link_libraries(${CEF_TARGET} libcef_dll_wrapper ${CEF_STANDARD_LIBS})
find_library(COCOA_LIBRARY Cocoa REQUIRED)
target_link_libraries(${CEF_TARGET} ${COCOA_LIBRARY})
set_target_properties(${CEF_TARGET} PROPERTIES
  MACOSX_BUNDLE_INFO_PLIST "${CMAKE_CURRENT_SOURCE_DIR}/mac/Info.plist.in"
)
COPY_MAC_FRAMEWORK(${CEF_TARGET} "${CEF_BINARY_DIR}" "${CEF_APP}")

foreach(_suffix_list ${CEF_HELPER_APP_SUFFIXES})
  string(REPLACE ":" ";" _suffix_list ${_suffix_list})
  list(GET _suffix_list 0 _name_suffix)
  list(GET _suffix_list 1 _target_suffix)
  list(GET _suffix_list 2 _plist_suffix)
  set(_helper_target "${CEF_HELPER_TARGET}${_target_suffix}")
  set(_helper_output_name "${CEF_HELPER_OUTPUT_NAME}${_name_suffix}")
  set(_helper_info_plist "${CMAKE_CURRENT_BINARY_DIR}/helper-Info${_target_suffix}.plist")
  file(READ "${CMAKE_CURRENT_SOURCE_DIR}/mac/helper-Info.plist.in" _plist_contents)
  string(REPLACE "\${EXECUTABLE_NAME}" "${_helper_output_name}" _plist_contents "${_plist_contents}")
  string(REPLACE "\${PRODUCT_NAME}" "${_helper_output_name}" _plist_contents "${_plist_contents}")
  string(REPLACE "\${BUNDLE_ID_SUFFIX}" "${_plist_suffix}" _plist_contents "${_plist_contents}")
  string(REPLACE "\${VERSION_SHORT}" "${VERSION_SHORT}" _plist_contents "${_plist_contents}")
  file(WRITE "${_helper_info_plist}" "${_plist_contents}")
  add_executable(${_helper_target} MACOSX_BUNDLE ${CEF_HELPER_SRCS})
  SET_EXECUTABLE_TARGET_PROPERTIES(${_helper_target})
  target_include_directories(${_helper_target} PRIVATE "${CMAKE_CURRENT_SOURCE_DIR}/../..")
  target_link_libraries(${_helper_target} libcef_dll_wrapper ${CEF_STANDARD_LIBS})
  set_target_properties(${_helper_target} PROPERTIES
    MACOSX_BUNDLE_INFO_PLIST "${_helper_info_plist}"
    OUTPUT_NAME "${_helper_output_name}"
  )
  add_dependencies(${CEF_TARGET} ${_helper_target})
  add_custom_command(TARGET ${CEF_TARGET} POST_BUILD
    COMMAND ${CMAKE_COMMAND} -E copy_directory
      "$<TARGET_BUNDLE_DIR:${_helper_target}>"
      "${CEF_APP}/Contents/Frameworks/${_helper_output_name}.app"
    VERBATIM
  )
endforeach()

set(CMAKE_XCODE_ATTRIBUTE_CODE_SIGNING_ALLOWED "NO")
set(CMAKE_XCODE_ATTRIBUTE_CODE_SIGNING_REQUIRED "NO")
