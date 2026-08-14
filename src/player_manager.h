#pragma once
#include <windows.h>
#include <string>
#include <vector>
#include <functional>

#if defined(_MSC_VER)
#include <BaseTsd.h>
typedef SSIZE_T ssize_t;
#endif
#include <vlc/vlc.h>


struct MediaTrackInfo {
    int index;
    std::string langName;
    std::string details;
};

class PlayerManager {
public:
    PlayerManager();
    ~PlayerManager();

    bool Initialize(HWND videoHwnd);
    void Shutdown();

    bool Load(const std::wstring& filePath);
    void Play();
    void Pause();
    void Stop();
    void Seek(double seconds);
    
    void SetVolume(double volumePercent); // 0.0 to 1.0
    void SetMute(bool mute);

    void SetAudioTrack(int trackId);
    void SetSubtitleTrack(int trackId);
    bool SetExternalSubtitle(const std::wstring& srtPath);

    double GetCurrentTime() const; // in seconds
    double GetDuration() const;    // in seconds
    bool IsPlaying() const;

    // Callbacks para eventos del reproductor
    void SetOnTimeUpdateCallback(std::function<void(double currentTime)> cb) { onTimeUpdate = cb; }
    void SetOnPlayingStateCallback(std::function<void(bool playing)> cb) { onPlayingState = cb; }
    void SetOnMediaLoadedCallback(std::function<void(double duration, const std::vector<MediaTrackInfo>& audioTracks, const std::vector<MediaTrackInfo>& subtitleTracks)> cb) { onMediaLoaded = cb; }

private:
    libvlc_instance_t* vlcInstance = nullptr;
    libvlc_media_player_t* mediaPlayer = nullptr;
    HWND hWndVideo = nullptr;
    mutable double cachedDuration = 0.0;
    bool isMuted = false;
    bool mediaLoadedFired = false;
    double currentVolume = 1.0; // 0.0 to 1.0

    // Callback handlers
    std::function<void(double currentTime)> onTimeUpdate;
    std::function<void(bool playing)> onPlayingState;
    std::function<void(double duration, const std::vector<MediaTrackInfo>& audioTracks, const std::vector<MediaTrackInfo>& subtitleTracks)> onMediaLoaded;

    static void VlcEventCallback(const struct libvlc_event_t* p_event, void* p_data);
    void HandleVlcEvent(const struct libvlc_event_t* p_event);
    std::vector<MediaTrackInfo> GetAudioTracks();
    std::vector<MediaTrackInfo> GetSubtitleTracks();
};
