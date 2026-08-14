cmake_minimum_required(VERSION 3.15)
project(SophyPlayer LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# Incluir FetchContent para gestionar descargas automáticas de dependencias
include(FetchContent)

# 1. Descargar Microsoft WebView2 SDK NuGet package
message(STATUS "Configurando descarga de WebView2 SDK...")
FetchContent_Declare(
    webview2
    URL "https://www.nuget.org/api/v2/package/Microsoft.Web.WebView2/1.0.2592.51"
)
FetchContent_GetProperties(webview2)
if(NOT webview2_POPULATED)
    FetchContent_Populate(webview2)
endif()

# 2. Descargar libVLC SDK y Binarios (VLC 3.0.18 desde NuGet)
if(CMAKE_SIZEOF_VOID_P EQUAL 8)
    set(ARCH_DIR "x64")
else()
    set(ARCH_DIR "x86")
endif()

message(STATUS "Configurando descarga de libVLC SDK (${ARCH_DIR}) desde NuGet...")
FetchContent_Declare(
    vlc
    URL "https://www.nuget.org/api/v2/package/VideoLAN.LibVLC.Windows/3.0.18"
)
FetchContent_GetProperties(vlc)
if(NOT vlc_POPULATED)
    FetchContent_Populate(vlc)
endif()

# Resolver rutas locales de dependencias descargadas
set(WEBVIEW2_INCLUDE_DIR "${webview2_SOURCE_DIR}/build/native/include")
set(WEBVIEW2_LIB "${webview2_SOURCE_DIR}/build/native/${ARCH_DIR}/WebView2Loader.dll.lib")
set(WEBVIEW2_DLL "${webview2_SOURCE_DIR}/build/native/${ARCH_DIR}/WebView2Loader.dll")

# La estructura descomprimida del NuGet de VLC
set(VLC_SDK_DIR "${vlc_SOURCE_DIR}/build/${ARCH_DIR}")
set(VLC_INCLUDE_DIR "${VLC_SDK_DIR}/include")
set(VLC_LIB_VLC "${VLC_SDK_DIR}/libvlc.lib")
set(VLC_LIB_CORE "${VLC_SDK_DIR}/libvlccore.lib")

set(VLC_DLL "${VLC_SDK_DIR}/libvlc.dll")
set(VLC_CORE_DLL "${VLC_SDK_DIR}/libvlccore.dll")
set(VLC_PLUGINS_DIR "${VLC_SDK_DIR}/plugins")

# 3. Definir el ejecutable de Windows (GUI sin ventana de comandos)
add_executable(SophyPlayer WIN32
    src/main.cpp
    src/webview_manager.cpp
    src/webview_manager.h
    src/player_manager.cpp
    src/player_manager.h
)

# Directorios de cabeceras
target_include_directories(SophyPlayer PRIVATE
    ${CMAKE_CURRENT_SOURCE_DIR}/src
    ${WEBVIEW2_INCLUDE_DIR}
    ${VLC_INCLUDE_DIR}
)

# Enlace de librerías nativas de Windows y dependencias
target_link_libraries(SophyPlayer PRIVATE
    ${WEBVIEW2_LIB}
    ${VLC_LIB_VLC}
    ${VLC_LIB_CORE}
    shlwapi
    user32
    gdi32
    ole32
    shell32
)

# 4. Comandos post-compilación para copiar DLLs, plugins e interfaz al directorio de salida
add_custom_command(TARGET SophyPlayer POST_BUILD
    COMMAND ${CMAKE_COMMAND} -E copy_if_different "${WEBVIEW2_DLL}" "$<TARGET_FILE_DIR:SophyPlayer>/"
    COMMAND ${CMAKE_COMMAND} -E copy_if_different "${VLC_DLL}" "$<TARGET_FILE_DIR:SophyPlayer>/"
    COMMAND ${CMAKE_COMMAND} -E copy_if_different "${VLC_CORE_DLL}" "$<TARGET_FILE_DIR:SophyPlayer>/"
    COMMAND ${CMAKE_COMMAND} -E copy_directory "${VLC_PLUGINS_DIR}" "$<TARGET_FILE_DIR:SophyPlayer>/plugins"
    COMMENT "Copiando DLLs de dependencias a la carpeta de salida..."
)

# Copiar la carpeta ui al lado del ejecutable para su funcionamiento local
add_custom_command(TARGET SophyPlayer POST_BUILD
    COMMAND ${CMAKE_COMMAND} -E make_directory "$<TARGET_FILE_DIR:SophyPlayer>/ui"
    COMMAND ${CMAKE_COMMAND} -E copy_if_different "${CMAKE_CURRENT_SOURCE_DIR}/index.html" "$<TARGET_FILE_DIR:SophyPlayer>/ui/"
    COMMAND ${CMAKE_COMMAND} -E copy_if_different "${CMAKE_CURRENT_SOURCE_DIR}/styles.css" "$<TARGET_FILE_DIR:SophyPlayer>/ui/"
    COMMAND ${CMAKE_COMMAND} -E copy_if_different "${CMAKE_CURRENT_SOURCE_DIR}/renderer.js" "$<TARGET_FILE_DIR:SophyPlayer>/ui/"
    COMMAND ${CMAKE_COMMAND} -E copy_if_different "${CMAKE_CURRENT_SOURCE_DIR}/logo.png" "$<TARGET_FILE_DIR:SophyPlayer>/ui/"
    COMMENT "Copiando archivos HTML/CSS/JS de la UI a la carpeta del ejecutable..."
)
