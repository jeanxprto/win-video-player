#pragma once
#include <windows.h>
#include <string>
#include <functional>
#include <wrl/client.h>
#include <WebView2.h>

class WebviewManager {
public:
    WebviewManager();
    ~WebviewManager();

    bool Initialize(HWND parentHwnd, std::function<void(const std::wstring& messageJson)> messageHandler);
    void Shutdown();
    void Resize();

    bool PostMessage(const std::wstring& messageJson);
    HWND GetHwnd() const { return hWndParent; }
    void SetFocus();

private:
    HWND hWndParent = nullptr;
    Microsoft::WRL::ComPtr<ICoreWebView2Controller> webviewController;
    Microsoft::WRL::ComPtr<ICoreWebView2> webviewWindow;
    std::function<void(const std::wstring& messageJson)> onMessageReceived;

    bool SetupWebView(ICoreWebView2Controller* controller);
};
