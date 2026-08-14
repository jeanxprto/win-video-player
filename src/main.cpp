#include <windows.h>
#include <windowsx.h>
#include <shobjidl.h>
#include <shlwapi.h>
#include <dwmapi.h>
#include <string>
#include <vector>
#include <iostream>
#include <sstream>
#include <thread>
#include <urlmon.h>
#include "webview_manager.h"
#include "player_manager.h"

#pragma comment(lib, "Shlwapi.lib")
#pragma comment(lib, "dwmapi.lib")
#pragma comment(lib, "urlmon.lib")

// Mensajes de usuario para comunicación entre hilos (VLC Thread -> UI Thread) y evitar reentrada en WebView2
#define WM_PLAYER_TIME_UPDATE (WM_USER + 1)
#define WM_PLAYER_PLAYING_STATE (WM_USER + 2)
#define WM_PLAYER_MEDIA_LOADED (WM_USER + 3)
#define WM_USER_OPEN_FILE_DIALOG (WM_USER + 4)
#define WM_USER_OPEN_SUBTITLE_DIALOG (WM_USER + 5)
#define WM_USER_UPDATE_DOWNLOAD_COMPLETE (WM_USER + 6)
#define WM_USER_UPDATE_DOWNLOAD_FAILED (WM_USER + 7)

struct MediaLoadedData {
    double duration;
    std::vector<MediaTrackInfo> audioTracks;
    std::vector<MediaTrackInfo> subtitleTracks;
};

// Prototipos de funciones Win32
LRESULT CALLBACK WndProc(HWND hWnd, UINT message, WPARAM wParam, LPARAM lParam);
LRESULT CALLBACK VideoWndProc(HWND hWnd, UINT message, WPARAM wParam, LPARAM lParam);

// Instancias globales
WebviewManager* g_webview = nullptr;
PlayerManager* g_player = nullptr;
HWND g_hWndParent = nullptr;
HWND g_hWndVideo = nullptr;

// Helper para convertir string UTF-8 a wstring UTF-16 en Windows
static std::wstring Utf8ToUtf16(const std::string& utf8Str) {
    if (utf8Str.empty()) return L"";
    int sizeNeeded = MultiByteToWideChar(CP_UTF8, 0, &utf8Str[0], (int)utf8Str.size(), NULL, 0);
    std::wstring utf16Str(sizeNeeded, 0);
    MultiByteToWideChar(CP_UTF8, 0, &utf8Str[0], (int)utf8Str.size(), &utf16Str[0], sizeNeeded);
    return utf16Str;
}

// Helper para extraer campos JSON sencillos
static std::wstring GetJsonValue(const std::wstring& json, const std::wstring& key) {
    size_t pos = json.find(L"\"" + key + L"\"");
    if (pos == std::wstring::npos) return L"";

    pos = json.find(L":", pos);
    if (pos == std::wstring::npos) return L"";

    size_t valStart = json.find_first_not_of(L" \t\r\n", pos + 1);
    if (valStart == std::wstring::npos) return L"";

    if (json[valStart] == L'"') {
        size_t valEnd = json.find(L"\"", valStart + 1);
        if (valEnd == std::wstring::npos) return L"";
        
        // Desescapar caracteres JSON típicos (\/ y \\)
        std::wstring raw = json.substr(valStart + 1, valEnd - valStart - 1);
        std::wstring unescaped;
        for (size_t i = 0; i < raw.length(); ++i) {
            if (raw[i] == L'\\' && i + 1 < raw.length()) {
                if (raw[i+1] == L'\\' || raw[i+1] == L'"' || raw[i+1] == L'/') {
                    unescaped += raw[i+1];
                    ++i;
                } else if (raw[i+1] == L'n') {
                    unescaped += L'\n';
                    ++i;
                } else {
                    unescaped += raw[i];
                }
            } else {
                unescaped += raw[i];
            }
        }
        return unescaped;
    } else {
        size_t valEnd = json.find_first_of(L",}", valStart);
        if (valEnd == std::wstring::npos) return L"";
        return json.substr(valStart, valEnd - valStart);
    }
}

// Abre el selector de archivos moderno de Windows
static std::wstring OpenFileDialog(HWND hwndParent, const std::vector<std::pair<std::wstring, std::wstring>>& filters) {
    std::wstring filePath;
    IFileOpenDialog* pFileOpen = nullptr;
    HRESULT hr = CoCreateInstance(CLSID_FileOpenDialog, NULL, CLSCTX_ALL, IID_IFileOpenDialog, reinterpret_cast<void**>(&pFileOpen));
    
    if (SUCCEEDED(hr)) {
        std::vector<COMDLG_FILTERSPEC> fileTypes;
        for (const auto& filter : filters) {
            fileTypes.push_back({ filter.first.c_str(), filter.second.c_str() });
        }
        pFileOpen->SetFileTypes(static_cast<UINT>(fileTypes.size()), fileTypes.data());
        
        hr = pFileOpen->Show(hwndParent);
        if (SUCCEEDED(hr)) {
            IShellItem* pItem = nullptr;
            hr = pFileOpen->GetResult(&pItem);
            if (SUCCEEDED(hr)) {
                wchar_t* pszFilePath = nullptr;
                hr = pItem->GetDisplayName(SIGDN_FILESYSPATH, &pszFilePath);
                if (SUCCEEDED(hr)) {
                    filePath = pszFilePath;
                    CoTaskMemFree(pszFilePath);
                }
                pItem->Release();
            }
        }
        pFileOpen->Release();
    }
    return filePath;
}

// Helper para escapar strings en JSON
static std::wstring EscapeJsonString(const std::wstring& input) {
    std::wstring output;
    for (wchar_t c : input) {
        if (c == L'\\') output += L"\\\\";
        else if (c == L'"') output += L"\\\"";
        else if (c == L'\n') output += L"\\n";
        else if (c == L'\r') output += L"\\r";
        else if (c == L'\t') output += L"\\t";
        else output += c;
    }
    return output;
}

// Procesa los mensajes recibidos desde el WebView2 (JS -> C++)
void HandleWebViewMessage(const std::wstring& messageJson) {
    std::wstring action = GetJsonValue(messageJson, L"action");

    if (action == L"window-minimize") {
        ShowWindow(g_hWndParent, SW_MINIMIZE);
    } 
    else if (action == L"window-maximize") {
        if (IsZoomed(g_hWndParent)) {
            ShowWindow(g_hWndParent, SW_RESTORE);
        } else {
            ShowWindow(g_hWndParent, SW_MAXIMIZE);
        }
    } 
    else if (action == L"window-close") {
        PostQuitMessage(0);
    } 
    else if (action == L"window-drag") {
        ReleaseCapture();
        SendMessage(g_hWndParent, WM_NCLBUTTONDOWN, HTCAPTION, 0);
    }
    else if (action == L"window-resize") {
        std::wstring dir = GetJsonValue(messageJson, L"direction");
        WPARAM wParamHit = HTCLIENT;
        if (dir == L"left") wParamHit = HTLEFT;
        else if (dir == L"right") wParamHit = HTRIGHT;
        else if (dir == L"top") wParamHit = HTTOP;
        else if (dir == L"bottom") wParamHit = HTBOTTOM;
        else if (dir == L"topleft") wParamHit = HTTOPLEFT;
        else if (dir == L"topright") wParamHit = HTTOPRIGHT;
        else if (dir == L"bottomleft") wParamHit = HTBOTTOMLEFT;
        else if (dir == L"bottomright") wParamHit = HTBOTTOMRIGHT;
        
        if (wParamHit != HTCLIENT) {
            ReleaseCapture();
            SendMessage(g_hWndParent, WM_NCLBUTTONDOWN, wParamHit, 0);
        }
    }
    else if (action == L"open-file-dialog") {
        PostMessageW(g_hWndParent, WM_USER_OPEN_FILE_DIALOG, 0, 0);
    }
    else if (action == L"show-in-folder") {
        std::wstring path = GetJsonValue(messageJson, L"path");
        if (!path.empty()) {
            std::wstring args = L"/select,\"" + path + L"\"";
            ShellExecuteW(NULL, L"open", L"explorer.exe", args.c_str(), NULL, SW_SHOWNORMAL);
        }
    }
    else if (action == L"load") {
        std::wstring path = GetJsonValue(messageJson, L"path");
        if (!path.empty()) {
            OutputDebugStringW((L"[SophyPlayer] action=load path=" + path + L"\n").c_str());
            // Mostrar ventana de video nativa para la reproducción
            ShowWindow(g_hWndVideo, SW_SHOW);
            g_player->Load(path);
        }
    }
    else if (action == L"play") {
        g_player->Play();
    }
    else if (action == L"pause") {
        g_player->Pause();
    }
    else if (action == L"stop") {
        g_player->Stop();
        ShowWindow(g_hWndVideo, SW_HIDE);
    }
    else if (action == L"seek") {
        std::wstring timeStr = GetJsonValue(messageJson, L"time");
        if (!timeStr.empty()) {
            double secs = std::stod(timeStr);
            g_player->Seek(secs);
        }
    }
    else if (action == L"volume") {
        std::wstring volStr = GetJsonValue(messageJson, L"volume");
        if (!volStr.empty()) {
            double vol = std::stod(volStr);
            g_player->SetVolume(vol);
        }
    }
    else if (action == L"mute") {
        std::wstring muteStr = GetJsonValue(messageJson, L"mute");
        bool mute = (muteStr == L"true");
        g_player->SetMute(mute);
    }
    else if (action == L"set-audio-track") {
        std::wstring idStr = GetJsonValue(messageJson, L"trackIndex");
        if (!idStr.empty()) {
            g_player->SetAudioTrack(std::stoi(idStr));
        }
    }
    else if (action == L"set-subtitle-track") {
        std::wstring idStr = GetJsonValue(messageJson, L"trackIndex");
        if (idStr == L"external") {
            std::wstring srtPath = GetJsonValue(messageJson, L"path");
            g_player->SetExternalSubtitle(srtPath);
        } else if (!idStr.empty()) {
            g_player->SetSubtitleTrack(std::stoi(idStr));
        }
    }
    else if (action == L"open-subtitle-dialog") {
        PostMessageW(g_hWndParent, WM_USER_OPEN_SUBTITLE_DIALOG, 0, 0);
    }
    else if (action == L"resize-video") {
        int left = std::stoi(GetJsonValue(messageJson, L"left"));
        int top = std::stoi(GetJsonValue(messageJson, L"top"));
        int width = std::stoi(GetJsonValue(messageJson, L"width"));
        int height = std::stoi(GetJsonValue(messageJson, L"height"));
        
        std::wstringstream ws;
        ws << L"[SophyPlayer] resize-video: left=" << left << L", top=" << top << L", width=" << width << L", height=" << height << L"\n";
        OutputDebugStringW(ws.str().c_str());

        // Guardar coordenadas en un archivo para depurar externamente
        FILE* f = nullptr;
        if (_wfopen_s(&f, L"debug_coords.txt", L"w") == 0) {
            fwprintf(f, L"left=%d\ntop=%d\nwidth=%d\nheight=%d\n", left, top, width, height);
            fclose(f);
        }

        // Mover la ventana de video nativa detrás del WebView2
        BOOL ok = SetWindowPos(g_hWndVideo, NULL, left, top, width, height, SWP_NOZORDER | SWP_NOACTIVATE);
        if (!ok) {
            OutputDebugStringW(L"[SophyPlayer] SetWindowPos failed!\n");
        }
    }
    else if (action == L"check-updates") {
        // Simular no actualizaciones para esta versión nativa de C++
        g_webview->PostMessage(L"{\"type\":\"update-status\",\"status\":\"no-disponible\"}");
    }
    else if (action == L"open-url") {
        std::wstring url = GetJsonValue(messageJson, L"url");
        if (!url.empty()) {
            ShellExecuteW(NULL, L"open", url.c_str(), NULL, NULL, SW_SHOWNORMAL);
        }
    }
    else if (action == L"start-download") {
        std::wstring url = GetJsonValue(messageJson, L"url");
        if (!url.empty()) {
            wchar_t tempPath[MAX_PATH];
            if (GetTempPathW(MAX_PATH, tempPath) > 0) {
                std::wstring destPath = std::wstring(tempPath) + L"sophy_player_setup.exe";
                
                // Descargar en segundo plano usando un hilo nativo
                std::thread([url, destPath]() {
                    HRESULT hr = URLDownloadToFileW(NULL, url.c_str(), destPath.c_str(), 0, NULL);
                    if (SUCCEEDED(hr)) {
                        // Enviar la ruta completa del instalador al hilo principal de la UI
                        std::wstring* pDestPath = new std::wstring(destPath);
                        PostMessageW(g_hWndParent, WM_USER_UPDATE_DOWNLOAD_COMPLETE, 0, reinterpret_cast<LPARAM>(pDestPath));
                    } else {
                        PostMessageW(g_hWndParent, WM_USER_UPDATE_DOWNLOAD_FAILED, 0, 0);
                    }
                }).detach();
            } else {
                g_webview->PostMessage(L"{\"type\":\"update-status\",\"status\":\"error\",\"info\":\"No se pudo obtener la ruta temporal de Windows.\"}");
            }
        }
    }
}

int APIENTRY wWinMain(_In_ HINSTANCE hInstance, _In_opt_ HINSTANCE hPrevInstance, _In_ LPWSTR lpCmdLine, _In_ int nCmdShow) {
    CoInitializeEx(NULL, COINIT_APARTMENTTHREADED);

    // 1. Registrar clase de la ventana principal
    WNDCLASSEXW wcex = { 0 };
    wcex.cbSize = sizeof(WNDCLASSEX);
    wcex.style = CS_HREDRAW | CS_VREDRAW;
    wcex.lpfnWndProc = WndProc;
    wcex.hInstance = hInstance;
    wcex.hCursor = LoadCursor(NULL, IDC_ARROW);
    wcex.hbrBackground = CreateSolidBrush(RGB(22, 26, 34)); // Fondo oscuro base (#161a22) para evitar bordes claros
    wcex.lpszClassName = L"SophyPlayerMainWindow";
    RegisterClassExW(&wcex);

    // 2. Registrar clase de la ventana de video secundaria
    WNDCLASSEXW wcexVideo = { 0 };
    wcexVideo.cbSize = sizeof(WNDCLASSEX);
    wcexVideo.lpfnWndProc = VideoWndProc;
    wcexVideo.hInstance = hInstance;
    wcexVideo.hbrBackground = CreateSolidBrush(RGB(0, 0, 0)); // Fondo negro para video
    wcexVideo.lpszClassName = L"SophyPlayerVideoWindow";
    RegisterClassExW(&wcexVideo);

    // 3. Crear la ventana principal (sin bordes tradicionales para usar la UI web)
    int screenWidth = GetSystemMetrics(SM_CXSCREEN);
    int screenHeight = GetSystemMetrics(SM_CYSCREEN);
    int windowWidth = 1280;
    int windowHeight = 720;
    int x = (screenWidth - windowWidth) / 2;
    int y = (screenHeight - windowHeight) / 2;

    g_hWndParent = CreateWindowExW(
        WS_EX_APPWINDOW, 
        L"SophyPlayerMainWindow", 
        L"Sophy Player", 
        WS_POPUP | WS_MINIMIZEBOX | WS_MAXIMIZEBOX | WS_THICKFRAME, // Removido WS_CLIPCHILDREN para permitir composición transparente
        x, y, windowWidth, windowHeight, 
        NULL, NULL, hInstance, NULL
    );

    if (!g_hWndParent) {
        return FALSE;
    }

    // Habilitar bordes redondeados nativos de Windows 11 para la ventana personalizada
    DWORD cornerPreference = 2; // DWMWCP_ROUND
    DwmSetWindowAttribute(g_hWndParent, 33, &cornerPreference, sizeof(cornerPreference));

    // 4. Crear la ventana de video nativa como hija de la principal
    g_hWndVideo = CreateWindowExW(
        0, 
        L"SophyPlayerVideoWindow", 
        L"", 
        WS_CHILD | WS_VISIBLE, // Removido WS_CLIPSIBLINGS para evitar interferencias de clipping en WebView2
        0, 0, 1280, 720, 
        g_hWndParent, NULL, hInstance, NULL
    );

    // Inicializar reproductor de libVLC
    g_player = new PlayerManager();
    if (!g_player->Initialize(g_hWndVideo)) {
        MessageBoxW(g_hWndParent, L"No se pudo inicializar libVLC. Verifica que VLC esté instalado correctamente.", L"Error de inicialización", MB_ICONERROR);
        return FALSE;
    }

    // Registrar callbacks del reproductor para notificar al WebView (marshaled a la cola del hilo de UI)
    g_player->SetOnTimeUpdateCallback([](double currentTime) {
        double* pTime = new double(currentTime);
        PostMessageW(g_hWndVideo, WM_PLAYER_TIME_UPDATE, 0, reinterpret_cast<LPARAM>(pTime));
    });

    g_player->SetOnPlayingStateCallback([](bool playing) {
        PostMessageW(g_hWndVideo, WM_PLAYER_PLAYING_STATE, playing ? 1 : 0, 0);
    });

    g_player->SetOnMediaLoadedCallback([](double duration, const std::vector<MediaTrackInfo>& audioTracks, const std::vector<MediaTrackInfo>& subtitleTracks) {
        MediaLoadedData* data = new MediaLoadedData{ duration, audioTracks, subtitleTracks };
        PostMessageW(g_hWndVideo, WM_PLAYER_MEDIA_LOADED, 0, reinterpret_cast<LPARAM>(data));
    });

    // 5. Inicializar WebView2 como hijo de la ventana principal (g_hWndParent)
    g_webview = new WebviewManager();
    if (!g_webview->Initialize(g_hWndParent, HandleWebViewMessage)) {
        MessageBoxW(g_hWndParent, L"No se pudo inicializar WebView2.", L"Error de entorno", MB_ICONERROR);
        return FALSE;
    }

    // Configurar Z-Order: la ventana de video va al fondo para dejar al WebView2 al frente transparente
    SetWindowPos(g_hWndVideo, HWND_BOTTOM, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);

    // Mostrar ventana principal
    ShowWindow(g_hWndParent, nCmdShow);
    UpdateWindow(g_hWndParent);

    // Bucle principal de mensajes
    MSG msg;
    while (GetMessage(&msg, NULL, 0, 0)) {
        TranslateMessage(&msg);
        DispatchMessage(&msg);
    }

    // Limpieza
    delete g_webview;
    delete g_player;

    CoUninitialize();
    return (int)msg.wParam;
}

LRESULT CALLBACK WndProc(HWND hWnd, UINT message, WPARAM wParam, LPARAM lParam) {
    switch (message) {
        case WM_SETFOCUS:
            if (g_webview) {
                g_webview->SetFocus();
            }
            break;


        case WM_USER_OPEN_FILE_DIALOG: {
            std::vector<std::pair<std::wstring, std::wstring>> filters = {
                { L"Archivos de Video", L"*.mp4;*.mkv;*.avi;*.mov;*.webm;*.flv;*.wmv" },
                { L"Todos los archivos", L"*.*" }
            };
            std::wstring pathSelected = OpenFileDialog(hWnd, filters);
            if (!pathSelected.empty()) {
                std::wstringstream ws;
                ws << L"{\"type\":\"file-selected\",\"path\":\"" << EscapeJsonString(pathSelected) << L"\"}";
                if (g_webview) g_webview->PostMessage(ws.str());
            }
            break;
        }

        case WM_USER_OPEN_SUBTITLE_DIALOG: {
            std::vector<std::pair<std::wstring, std::wstring>> filters = {
                { L"Archivos de Subtítulos", L"*.srt;*.vtt" }
            };
            std::wstring pathSelected = OpenFileDialog(hWnd, filters);
            if (!pathSelected.empty()) {
                std::wstringstream ws;
                ws << L"{\"type\":\"subtitle-selected\",\"path\":\"" << EscapeJsonString(pathSelected) << L"\"}";
                if (g_webview) g_webview->PostMessage(ws.str());
            }
            break;
        }

        case WM_NCACTIVATE:
            // Evitar que Windows dibuje bordes por defecto cuando la ventana pierde el foco o se desactiva
            return TRUE;

        case WM_SIZE: {
            RECT rc;
            GetClientRect(hWnd, &rc);
            if (g_hWndVideo) {
                SetWindowPos(g_hWndVideo, NULL, 0, 0, rc.right, rc.bottom, SWP_NOZORDER | SWP_NOACTIVATE);
            }
            if (g_webview) {
                g_webview->Resize();
            }
            break;
        }

        case WM_NCCALCSIZE:
            // Ocultar borde y barra de título estándar de Windows pero mantener funcionalidades de redimensionado nativo
            if (wParam == TRUE) {
                return 0;
            }
            break;

        case WM_NCHITTEST: {
            // Prueba de redimensionamiento nativo en bordes para ventana sin bordes
            const int border_width = 8;
            POINT pt;
            pt.x = GET_X_LPARAM(lParam);
            pt.y = GET_Y_LPARAM(lParam);
            ScreenToClient(hWnd, &pt);

            RECT rc;
            GetClientRect(hWnd, &rc);

            bool left = pt.x < border_width;
            bool right = pt.x > rc.right - border_width;
            bool top = pt.y < border_width;
            bool bottom = pt.y > rc.bottom - border_width;

            if (top && left) return HTTOPLEFT;
            if (top && right) return HTTOPRIGHT;
            if (bottom && left) return HTBOTTOMLEFT;
            if (bottom && right) return HTBOTTOMRIGHT;
            if (left) return HTLEFT;
            if (right) return HTRIGHT;
            if (top) return HTTOP;
            if (bottom) return HTBOTTOM;

            return HTCLIENT;
        }

        case WM_USER_UPDATE_DOWNLOAD_COMPLETE: {
            std::wstring* pDestPath = reinterpret_cast<std::wstring*>(lParam);
            if (pDestPath) {
                // Ejecutar el instalador de forma silenciosa (/S para NSIS)
                HINSTANCE hInst = ShellExecuteW(NULL, L"open", pDestPath->c_str(), L"/S", NULL, SW_SHOWNORMAL);
                if ((INT_PTR)hInst > 32) {
                    // Salir de la aplicación para permitir que el instalador sobrescriba el archivo ejecutable
                    PostQuitMessage(0);
                } else {
                    if (g_webview) g_webview->PostMessage(L"{\"type\":\"update-status\",\"status\":\"error\",\"info\":\"No se pudo ejecutar el instalador descargado.\"}");
                }
                delete pDestPath;
            }
            break;
        }

        case WM_USER_UPDATE_DOWNLOAD_FAILED: {
            if (g_webview) {
                g_webview->PostMessage(L"{\"type\":\"update-status\",\"status\":\"error\",\"info\":\"Error al descargar el archivo de actualización de Sophy Player.\"}");
            }
            break;
        }

        case WM_DESTROY:
            PostQuitMessage(0);
            break;

        default:
            return DefWindowProc(hWnd, message, wParam, lParam);
    }
    return 0;
}

LRESULT CALLBACK VideoWndProc(HWND hWnd, UINT message, WPARAM wParam, LPARAM lParam) {
    switch (message) {
        case WM_PLAYER_TIME_UPDATE: {
            double* pTime = reinterpret_cast<double*>(lParam);
            if (pTime) {
                if (g_webview) {
                    std::wstringstream ws;
                    ws << L"{\"type\":\"time-update\",\"currentTime\":" << *pTime << L"}";
                    g_webview->PostMessage(ws.str());
                }
                delete pTime;
            }
            return 0;
        }
        case WM_PLAYER_PLAYING_STATE: {
            bool playing = wParam != 0;
            if (g_webview) {
                std::wstringstream ws;
                ws << L"{\"type\":\"playing-state\",\"playing\":" << (playing ? L"true" : L"false") << L"}";
                g_webview->PostMessage(ws.str());
            }
            return 0;
        }
        case WM_PLAYER_MEDIA_LOADED: {
            MediaLoadedData* data = reinterpret_cast<MediaLoadedData*>(lParam);
            if (data) {
                if (g_webview) {
                    std::wstringstream ws;
                    ws << L"{\"type\":\"media-loaded\",\"duration\":" << data->duration;
                    
                    // Serializar pistas de audio
                    ws << L",\"audioTracks\":[";
                    for (size_t i = 0; i < data->audioTracks.size(); ++i) {
                        ws << L"{\"index\":" << data->audioTracks[i].index 
                           << L",\"langName\":\"" << EscapeJsonString(Utf8ToUtf16(data->audioTracks[i].langName)) << L"\""
                           << L",\"details\":\"" << EscapeJsonString(Utf8ToUtf16(data->audioTracks[i].details)) << L"\"}";
                        if (i + 1 < data->audioTracks.size()) ws << L",";
                    }
                    ws << L"]";

                    // Serializar pistas de subtítulos
                    ws << L",\"subtitleTracks\":[";
                    for (size_t i = 0; i < data->subtitleTracks.size(); ++i) {
                        ws << L"{\"index\":" << data->subtitleTracks[i].index 
                           << L",\"langName\":\"" << EscapeJsonString(Utf8ToUtf16(data->subtitleTracks[i].langName)) << L"\""
                           << L",\"details\":\"" << EscapeJsonString(Utf8ToUtf16(data->subtitleTracks[i].details)) << L"\"}";
                        if (i + 1 < data->subtitleTracks.size()) ws << L",";
                    }
                    ws << L"]}";

                    g_webview->PostMessage(ws.str());
                }
                delete data;
            }
            return 0;
        }
    }
    // La ventana de video es controlada internamente por libVLC, pero dejamos que procese los eventos básicos
    return DefWindowProc(hWnd, message, wParam, lParam);
}
