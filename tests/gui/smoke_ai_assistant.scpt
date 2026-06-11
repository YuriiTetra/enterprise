-- ============================================================================
-- OES Enterprise — AI Assistant GUI smoke test
-- ----------------------------------------------------------------------------
-- Drives designer.app through the macOS UI to verify the AI Assistant pane
-- boots, accepts input, sends to aiBridge, receives a response, and writes
-- the expected diagnostic markers to /tmp/oes-diag.log.
--
-- Usage:
--   osascript /Volumes/T9/Web/oes-enterprise/tests/gui/smoke_ai_assistant.scpt
--
-- Requirements:
--   - Debug build at /Volumes/T9/Web/oes-enterprise/build/bin/Debug/designer.app
--   - Accessibility permission granted to /usr/bin/osascript (System Settings →
--     Privacy & Security → Accessibility). The script detects and reports
--     the missing permission with a clear message.
--   - Screen Recording permission granted to /usr/bin/osascript if you want
--     the screencapture step to include other windows in the frame.
--
-- Exit codes:
--   0  PASS — all markers found, screenshot saved
--   1  FAIL — designer did not boot
--   2  FAIL — AI Assistant pane could not be opened
--   3  FAIL — input was not delivered
--   4  FAIL — no response markers in diagnostic log
--   5  FAIL — accessibility permission missing
--   6  FAIL — designer build not found on disk
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Configuration
-- ---------------------------------------------------------------------------
set repoRoot         to "/Volumes/T9/Web/oes-enterprise"
set designerBundle   to repoRoot & "/build/bin/Debug/designer.app"
set diagLogPath      to "/tmp/oes-diag.log"
set screenshotPrefix to "/tmp/oes-ai-smoke-"
set bootWaitSeconds  to 5
set responseWaitSec  to 10

-- Markers we expect to see in the diagnostic log after a successful turn.
-- "LegacyLLMShim" only fires if the active plugin is the v3 pugi bridge;
-- "aiBridge" fires for the first-party plugin; "triple_review" fires only
-- if the test message triggered a /review flow. We require at least ONE
-- of the three to be present — that is the success signal.
set markerList to {"LegacyLLMShim", "aiBridge", "triple_review"}

-- ---------------------------------------------------------------------------
-- Step 0: Verify the designer build exists on disk before we do anything.
-- ---------------------------------------------------------------------------
try
    do shell script "test -d " & quoted form of designerBundle
on error
    log "FAIL: designer build not found at " & designerBundle
    log "      Run: cmake --build build --target designer --parallel 3"
    return 6
end try

-- ---------------------------------------------------------------------------
-- Step 1: Kill any running designer process so we start from a clean state.
-- We use pkill -f to match the bundle name; -9 is intentional because the
-- Debug build sometimes hangs on shutdown when a debugger is attached.
-- ---------------------------------------------------------------------------
log "[1/10] Killing any running designer process..."
try
    do shell script "pkill -9 -f 'designer.app/Contents/MacOS/designer' || true"
on error errMsg
    log "WARN: pkill emitted: " & errMsg
end try

-- Give the OS a beat to reap the process so the next launch gets a fresh PID.
delay 1

-- ---------------------------------------------------------------------------
-- Step 2: Truncate the diagnostic log so we only see markers from THIS run.
-- ---------------------------------------------------------------------------
log "[2/10] Truncating diagnostic log at " & diagLogPath & "..."
do shell script "true > " & quoted form of diagLogPath

-- ---------------------------------------------------------------------------
-- Step 3: Launch designer.app via `open`. We deliberately do not use
-- `tell application "designer" to activate` because the bundle id may
-- not match what AppleScript expects on a Debug build.
-- ---------------------------------------------------------------------------
log "[3/10] Launching " & designerBundle & "..."
try
    do shell script "open " & quoted form of designerBundle
on error errMsg
    log "FAIL: could not launch designer: " & errMsg
    return 1
end try

-- ---------------------------------------------------------------------------
-- Step 4: Wait for the boot sequence. Five seconds covers cold-start on
-- macOS 14 with Firebird embedded. We poll the diagnostic log instead of
-- a flat sleep when possible — if the log shows the boot-complete marker
-- early we proceed.
-- ---------------------------------------------------------------------------
log "[4/10] Waiting up to " & bootWaitSeconds & "s for boot..."
set bootStart to current date
repeat while ((current date) - bootStart) < bootWaitSeconds
    try
        set bootMatch to do shell script "grep -c 'Designer ready' " & quoted form of diagLogPath & " || true"
        if bootMatch is not "0" then
            log "      Detected 'Designer ready' marker — boot complete."
            exit repeat
        end if
    end try
    delay 1
end repeat

-- Verify the designer process is actually running before we try to drive it.
set processCheck to do shell script "pgrep -f 'designer.app/Contents/MacOS/designer' | wc -l | tr -d ' '"
if processCheck is "0" then
    log "FAIL: designer process is not running after boot wait."
    return 1
end if

-- ---------------------------------------------------------------------------
-- Step 5: Verify accessibility permission. If osascript cannot drive
-- System Events, every keystroke that follows will silently no-op. We
-- detect this by attempting a benign query and catching the -1719 error
-- that macOS raises when the permission is missing.
-- ---------------------------------------------------------------------------
log "[5/10] Verifying accessibility permission..."
try
    tell application "System Events"
        set frontProcessName to name of first process whose frontmost is true
    end tell
    log "      Front process: " & frontProcessName
on error errMsg number errNum
    if errNum is -1719 or errMsg contains "not allowed" then
        log "FAIL: osascript lacks Accessibility permission."
        log "      Grant it: System Settings → Privacy & Security → Accessibility → add /usr/bin/osascript"
        return 5
    else
        log "WARN: System Events query failed: " & errMsg
    end if
end try

-- Bring designer to the foreground. The bundle's display name is "designer"
-- on the Debug build; we tolerate either casing.
try
    tell application "System Events"
        set designerProc to first process whose name is "designer"
        set frontmost of designerProc to true
    end tell
on error
    try
        tell application "System Events"
            set designerProc to first process whose name is "Designer"
            set frontmost of designerProc to true
        end tell
    on error errMsg
        log "FAIL: could not bring designer to front: " & errMsg
        return 1
    end try
end try

delay 1

-- ---------------------------------------------------------------------------
-- Step 6: Open the AI Assistant pane via the Tools menu. The Russian UI
-- label is «ИИ-ассистент»; the menu path is Tools → AI Assistant. We try
-- both English and Russian labels in case the build was localized.
--
-- If the menu navigation fails we fall back to the keyboard shortcut
-- (Cmd+Shift+A) which is bound to the same action.
-- ---------------------------------------------------------------------------
log "[6/10] Opening AI Assistant pane..."
set paneOpened to false

try
    tell application "System Events"
        tell process "designer"
            -- English label first
            try
                click menu item "AI Assistant" of menu "Tools" of menu bar 1
                set paneOpened to true
            on error
                -- Russian label fallback
                try
                    click menu item "ИИ-ассистент" of menu "Сервис" of menu bar 1
                    set paneOpened to true
                end try
            end try
        end tell
    end tell
on error errMsg
    log "      Menu-click path failed: " & errMsg
end try

-- Fallback: keyboard shortcut
if not paneOpened then
    log "      Falling back to keyboard shortcut Cmd+Shift+A..."
    try
        tell application "System Events"
            keystroke "a" using {command down, shift down}
        end tell
        set paneOpened to true
    on error errMsg
        log "FAIL: could not open AI Assistant pane: " & errMsg
        return 2
    end try
end if

-- Give the pane a moment to render and acquire focus on its input.
delay 2

-- ---------------------------------------------------------------------------
-- Step 7: Type "ping" into the chat input. We rely on the pane putting
-- focus on the input automatically when it opens. If that contract breaks,
-- the smoke test will fail in step 9 with no response markers, which is
-- the right failure mode.
-- ---------------------------------------------------------------------------
log "[7/10] Typing 'ping' into chat input..."
try
    tell application "System Events"
        keystroke "ping"
    end tell
on error errMsg
    log "FAIL: could not type into chat input: " & errMsg
    return 3
end try

delay 1

-- ---------------------------------------------------------------------------
-- Step 8: Send. Enter submits in single-line mode; Cmd+Enter submits in
-- multi-line mode. We send Cmd+Enter to cover both cases — single-line
-- treats it as a plain Enter, multi-line treats it as the send shortcut.
-- ---------------------------------------------------------------------------
log "[8/10] Sending message (Cmd+Enter)..."
try
    tell application "System Events"
        keystroke return using {command down}
    end tell
on error errMsg
    log "FAIL: could not send message: " & errMsg
    return 3
end try

-- ---------------------------------------------------------------------------
-- Step 9: Wait for response markers in the diagnostic log. We poll up to
-- responseWaitSec, returning early as soon as any expected marker shows up.
-- ---------------------------------------------------------------------------
log "[9/10] Waiting up to " & responseWaitSec & "s for response markers..."
set markersHit to {}
set responseStart to current date
repeat while ((current date) - responseStart) < responseWaitSec
    repeat with marker in markerList
        if marker is not in markersHit then
            try
                set hitCount to do shell script "grep -c " & quoted form of marker & " " & quoted form of diagLogPath & " || true"
                if hitCount is not "0" then
                    set end of markersHit to (marker as string)
                    log "      Marker hit: " & marker & " (" & hitCount & " occurrences)"
                end if
            end try
        end if
    end repeat
    if (count of markersHit) > 0 then exit repeat
    delay 1
end repeat

-- ---------------------------------------------------------------------------
-- Step 10: Take a screenshot regardless of pass/fail — visual evidence is
-- the most useful artifact when debugging a failed smoke test on CI.
-- ---------------------------------------------------------------------------
log "[10/10] Taking screenshot..."
set tsCommand to "date +%Y%m%d-%H%M%S | tr -d '\\n'"
set timestamp to do shell script tsCommand
set screenshotPath to screenshotPrefix & timestamp & ".png"
try
    -- -x: no shutter sound; -T 0: no delay; full screen capture.
    do shell script "screencapture -x -T 0 " & quoted form of screenshotPath
    log "      Screenshot saved to " & screenshotPath
on error errMsg
    log "WARN: screencapture failed: " & errMsg
    log "      The smoke test will continue, but visual evidence is missing."
    log "      Grant Screen Recording permission to /usr/bin/osascript if needed."
end try

-- ---------------------------------------------------------------------------
-- Verdict
-- ---------------------------------------------------------------------------
log "------------------------------------------------------------"
log "Markers found: " & (count of markersHit) & " of " & (count of markerList)
repeat with m in markersHit
    log "  - " & (m as string)
end repeat

if (count of markersHit) is 0 then
    log "FAIL: no response markers detected in " & diagLogPath
    log "      Inspect the log and the screenshot for clues."
    return 4
end if

log "PASS: AI Assistant smoke test completed."
log "      Screenshot: " & screenshotPath
log "      Diagnostic log: " & diagLogPath
return 0
