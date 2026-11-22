# PongPing core: platform-independent C++ DSP.
#
# The Xcode project compiles these sources into the plugin. This CMake build
# exists so the core can be built and tested anywhere, including CI on Linux.
cmake_minimum_required(VERSION 3.24)
project(PongPingCore LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 23)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

option(PONGPING_SANITIZE "Build with address and undefined-behaviour sanitizers" OFF)

add_library(pongping_core STATIC
    src/HostProbe.cpp
    src/Midi.cpp
    src/SineKernel.cpp)
target_include_directories(pongping_core PUBLIC include)
target_compile_options(pongping_core PRIVATE -Wall -Wextra -Wpedantic -Werror)

add_executable(pongping_tests tests/Tests.cpp)
target_link_libraries(pongping_tests PRIVATE pongping_core)
target_compile_options(pongping_tests PRIVATE -Wall -Wextra -Werror)

if(PONGPING_SANITIZE)
    foreach(t pongping_core pongping_tests)
        target_compile_options(${t} PRIVATE -fsanitize=address,undefined -fno-omit-frame-pointer)
        target_link_options(${t} PRIVATE -fsanitize=address,undefined)
    endforeach()
endif()

enable_testing()
add_test(NAME pongping_tests COMMAND pongping_tests)
