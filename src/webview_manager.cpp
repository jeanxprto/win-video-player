#include "webview_manager.h"
#include <iostream>

static bool FileExists(const std::wstring& path) {
    DWORD dwAttrib = GetFileAttributesW(path.c_str());
    return (dwAttrib != INVALID_FILE_ATTRIBUTES && !(dwAttrib & FILE_ATTRIBUTE_DIRECTORY));
}

static bool DirectoryExists(const std::wstring& path) {
    DWORD dwAttrib = GetFileAttributesW(path.c_str());
    return (dwAttrib != INVALID_FILE_ATTRIBUTES && (dwAttrib & FILE_ATTRIBUTE_DIRECTORY));
}

static std::wstring GetExecutableDirectory() {
    wchar_t buffer[MAX_PATH];
    GetModuleFileNameW(NULL, buffer, MAX_PATH);
    std::wstring path(buffer);
    size_t pos = path.find_last_of(L"\\/");
    return (pos == std::wstring::npos) ? L"" : path.substr(0, pos);
}

// Resuelve la ruta al directorio de la UI buscando en el exe dir y directorios superiores de desarrollo
static std::wstring ResolveUiDirectory() {
    std::wstring exeDir = GetExecutableDirectory();
    
    // 1. Verificar si existe carpeta "ui" al lado del ejecutable
    std::wstring uiPath = exeDir + L"\\ui";
    if (DirectoryExists(uiPath) && FileExists(uiPath + L"\\index.html")) {
        return uiPath;
    }

    // 2. Verificar si index.html está directamente al lado del ejecutable
    if (FileExists(exeDir + L"\\index.html")) {
        return exeDir;
    }

    // 3. Buscar hacia arriba en desarrollo (ej. exe está en build/Debug/ y archivos en el root del proyecto)
    std::wstring parentDir = exeDir;
    for (int i = 0; i < 4; ++i) {
        size_t pos = parentDir.find_last_of(L"\\/");
        if (pos == std::wstring::npos) break;
        parentDir = parentDir.substr(0, pos);

        std::wstring checkUi = parentDir + L"\\ui";
        if (DirectoryExists(checkUi) && FileExists(checkUi + L"\\index.html")) {
            return checkUi;
        }
        if (FileExists(parentDir + L"\\index.html")) {
            return parentDir;
        }
    }
    
    return exeDir; // fallback
}

WebviewManager::WebviewManager() {}

WebviewManager::~WebviewManager() {
    Shutdown();
}

bool WebviewManager::Initialize(HWND parentHwnd, std::function<void(const std::wstring&)> messageHandler) {
    // Forzar fondo transparente por defecto en WebView2 para evitar parpadeos y pantalla blanca
    SetEnvironmentVariableW(L"WEBVIEW2_DEFAULT_BACKGROUND_COLOR", L"00FFFFFF");

    hWndParent = parentHwnd;
    onMessageReceived = messageHandler;

    // Callback en C++ usando plantillas estándar de Windows para simplificar la creación de manejadores COM
    // sin requerir la macro Callback de wil
    class EnvironmentCreatedHandler : public ICoreWebView2CreateCoreWebView2EnvironmentCompletedHandler {
    private:
        HWND m_parent;
        std::function<void(ICoreWebView2Controller*)> m_successCallback;
    public:
        EnvironmentCreatedHandler(HWND parent, std::function<void(ICoreWebView2Controller*)> successCallback)
            : m_parent(parent), m_successCallback(successCallback) {}

        HRESULT STDMETHODCALLTYPE QueryInterface(REFIID riid, void** ppvObject) override {
            if (riid == IID_IUnknown || riid == IID_ICoreWebView2CreateCoreWebView2EnvironmentCompletedHandler) {
                *ppvObject = this;
                return S_OK;
            }
            return E_NOINTERFACE;
        }
        ULONG STDMETHODCALLTYPE AddRef() override { return 1; }
        ULONG STDMETHODCALLTYPE Release() override { return 1; }

        HRESULT STDMETHODCALLTYPE Invoke(HRESULT result, ICoreWebView2Environment* env) override {
            if (FAILED(result)) {
                std::wstring msg = L"Error al crear el entorno de WebView2: 0x" + std::to_wstring(result);
                MessageBoxW(NULL, msg.c_str(), L"Error de WebView2", MB_ICONERROR);
                return result;
            }

            class ControllerCreatedHandler : public ICoreWebView2CreateCoreWebView2ControllerCompletedHandler {
            private:
                std::function<void(ICoreWebView2Controller*)> m_successCallback;
            public:
                ControllerCreatedHandler(std::function<void(ICoreWebView2Controller*)> successCallback)
                    : m_successCallback(successCallback) {}

                HRESULT STDMETHODCALLTYPE QueryInterface(REFIID riid, void** ppvObject) override {
                    if (riid == IID_IUnknown || riid == IID_ICoreWebView2CreateCoreWebView2ControllerCompletedHandler) {
                        *ppvObject = this;
                        return S_OK;
                    }
                    return E_NOINTERFACE;
                }
                ULONG STDMETHODCALLTYPE AddRef() override { return 1; }
                ULONG STDMETHODCALLTYPE Release() override { return 1; }

                HRESULT STDMETHODCALLTYPE Invoke(HRESULT result, ICoreWebView2Controller* controller) override {
                    if (FAILED(result)) {
                        std::wstring msg = L"Error al crear el controlador de WebView2: 0x" + std::to_wstring(result);
                        MessageBoxW(NULL, msg.c_str(), L"Error de WebView2", MB_ICONERROR);
                        return result;
                    }
                    m_successCallback(controller);
                    return S_OK;
                }
            };

            auto handler = new ControllerCreatedHandler(m_successCallback);
            env->CreateCoreWebView2Controller(m_parent, handler);
            return S_OK;
        }
    };

    auto successCallback = [this](ICoreWebView2Controller* controller) {
        webviewController = controller;
        webviewController->get_CoreWebView2(&webviewWindow);
        webviewController->put_IsVisible(TRUE);
        if (SetupWebView(webviewController.Get())) {
            Resize();
        }
    };

    // Determinar la ruta de la carpeta de datos de usuario para WebView2
    // Se usa %LOCALAPPDATA% para evitar errores de permisos de escritura si la app se instala en Archivos de programa (Program Files)
    wchar_t localAppData[MAX_PATH];
    std::wstring userDataFolder;
    if (GetEnvironmentVariableW(L"LOCALAPPDATA", localAppData, MAX_PATH) > 0) {
        userDataFolder = std::wstring(localAppData) + L"\\SophyPlayer\\WebView2";
    } else {
        wchar_t tempPath[MAX_PATH];
        if (GetTempPathW(MAX_PATH, tempPath) > 0) {
            userDataFolder = std::wstring(tempPath) + L"SophyPlayerWebView2";
        }
    }

    auto handler = new EnvironmentCreatedHandler(hWndParent, successCallback);
    HRESULT hr = CreateCoreWebView2EnvironmentWithOptions(nullptr, userDataFolder.empty() ? nullptr : userDataFolder.c_str(), nullptr, handler);
    return SUCCEEDED(hr);
}

bool WebviewManager::SetupWebView(ICoreWebView2Controller* controller) {
    if (!webviewWindow) return false;

    // 1. Configurar transparencia de fondo de WebView2
    COREWEBVIEW2_COLOR transparentColor = { 0, 0, 0, 0 };
    Microsoft::WRL::ComPtr<ICoreWebView2Controller2> controller2;
    HRESULT hrAs = webviewController.As(&controller2);
    HRESULT hrPut = E_FAIL;
    if (SUCCEEDED(hrAs)) {
        hrPut = controller2->put_DefaultBackgroundColor(transparentColor);
    }

    FILE* fDebug = nullptr;
    if (_wfopen_s(&fDebug, L"debug_webview.txt", L"w") == 0) {
        fwprintf(fDebug, L"hrAs=0x%08X\nhrPut=0x%08X\n", hrAs, hrPut);
        fclose(fDebug);
    }

    // Deshabilitar el menú contextual por defecto de Chromium y barra de estado
    Microsoft::WRL::ComPtr<ICoreWebView2Settings> settings;
    if (SUCCEEDED(webviewWindow->get_Settings(&settings))) {
        settings->put_AreDefaultContextMenusEnabled(FALSE);
        settings->put_IsStatusBarEnabled(FALSE);
        settings->put_AreDevToolsEnabled(TRUE); 
    }

    // 2. Escuchar mensajes del frontend (JS -> C++)
    class MessageReceivedHandler : public ICoreWebView2WebMessageReceivedEventHandler {
    private:
        std::function<void(const std::wstring&)> m_cb;
    public:
        MessageReceivedHandler(std::function<void(const std::wstring&)> cb) : m_cb(cb) {}

        HRESULT STDMETHODCALLTYPE QueryInterface(REFIID riid, void** ppvObject) override {
            if (riid == IID_IUnknown || riid == IID_ICoreWebView2WebMessageReceivedEventHandler) {
                *ppvObject = this;
                return S_OK;
            }
            return E_NOINTERFACE;
        }
        ULONG STDMETHODCALLTYPE AddRef() override { return 1; }
        ULONG STDMETHODCALLTYPE Release() override { return 1; }

        HRESULT STDMETHODCALLTYPE Invoke(ICoreWebView2* sender, ICoreWebView2WebMessageReceivedEventArgs* args) override {
            LPWSTR messageRaw = nullptr;
            if (SUCCEEDED(args->TryGetWebMessageAsString(&messageRaw))) {
                std::wstring msg = messageRaw;
                CoTaskMemFree(messageRaw);
                if (m_cb) {
                    m_cb(msg);
                }
            }
            return S_OK;
        }
    };

    auto msgHandler = new MessageReceivedHandler(onMessageReceived);
    webviewWindow->add_WebMessageReceived(msgHandler, nullptr);

    // 3. Mapear directorio de UI local a un host virtual http://sophyplayer.local
    std::wstring uiFolder = ResolveUiDirectory();
    std::wcout << L"[WebView2] Mapeando host sophyplayer.local al directorio: " << uiFolder << std::endl;
    
    Microsoft::WRL::ComPtr<ICoreWebView2_3> webviewWindow3;
    HRESULT hr = webviewWindow.As(&webviewWindow3);
    if (SUCCEEDED(hr)) {
        hr = webviewWindow3->SetVirtualHostNameToFolderMapping(
            L"sophyplayer.local",
            uiFolder.c_str(),
            COREWEBVIEW2_HOST_RESOURCE_ACCESS_KIND_ALLOW
        );
    } else {
        std::cerr << "[WebView2] No se pudo obtener la interfaz ICoreWebView2_3" << std::endl;
        return false;
    }

    if (FAILED(hr)) {
        std::cerr << "[WebView2] Error en SetVirtualHostNameToFolderMapping" << std::endl;
        return false;
    }

    // Navegar a la interfaz
    webviewWindow->Navigate(L"https://sophyplayer.local/index.html");
    return true;
}

void WebviewManager::Shutdown() {
    if (webviewController) {
        webviewController->Close();
        webviewController = nullptr;
    }
    webviewWindow = nullptr;
    hWndParent = nullptr;
}

void WebviewManager::Resize() {
    if (webviewController) {
        RECT bounds;
        GetClientRect(hWndParent, &bounds);
        webviewController->put_Bounds(bounds);
    }
}

bool WebviewManager::PostMessage(const std::wstring& messageJson) {
    if (webviewWindow) {
        HRESULT hr = webviewWindow->PostWebMessageAsJson(messageJson.c_str());
        return SUCCEEDED(hr);
    }
    return false;
}

void WebviewManager::SetFocus() {
    if (webviewController) {
        webviewController->MoveFocus(COREWEBVIEW2_MOVE_FOCUS_REASON_PROGRAMMATIC);
    }
}
