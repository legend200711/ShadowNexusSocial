/**
 * jitsi-live.js — Shadow Nexus Social
 * Jitsi Meet integration for the live stage.
 *
 * startJitsiLive(roomID, username)  — mount and join a room
 * endJitsiLive()                    — dispose and leave
 */

let jitsiAPI = null;

function startJitsiLive(roomID, username) {

    const domain = "meet.jit.si";

    const options = {
        roomName: roomID,

        width: "100%",
        height: "100%",

        parentNode: document.querySelector("#jitsi-live-room"),

        userInfo: {
            displayName: username
        },

        configOverwrite: {
            startWithAudioMuted: false,
            startWithVideoMuted: false,
            disableDeepLinking: true
        },

        interfaceConfigOverwrite: {
            SHOW_JITSI_WATERMARK: false,
            TOOLBAR_BUTTONS: [
                "microphone",
                "camera",
                "chat",
                "participants-pane",
                "hangup"
            ]
        }
    };

    jitsiAPI = new JitsiMeetExternalAPI(domain, options);

    jitsiAPI.addEventListener("videoConferenceJoined", function () {
        console.log("Shadow Nexus Live started");
        document.querySelector("#jitsi-live-room").classList.add("jitsi-active");
    });

    jitsiAPI.addEventListener("videoConferenceLeft", function () {
        console.log("Shadow Nexus Live ended");
        endJitsiLive();
    });
}

function endJitsiLive() {

    if (jitsiAPI) {
        jitsiAPI.dispose();
        jitsiAPI = null;
    }

    const room = document.querySelector("#jitsi-live-room");
    if (room) {
        room.classList.remove("jitsi-active");
        room.innerHTML = "";
    }
}
