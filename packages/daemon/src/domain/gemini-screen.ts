import { SHELL_COMMANDS, type NativeResumeProbeResult } from "./native-resume-probe.js";

// What a tmux pane running the Gemini CLI is showing, read from its screen. The strings are the Gemini CLI's own
// interface text (google-gemini/gemini-cli, packages/cli/src/ui, v0.62): the input placeholder, the folder trust
// dialog and the sign-in dialogs. The result uses the same vocabulary as the Claude and Codex probes, so
// "login_required" and "trust_gate" already mean "a person is needed" everywhere readiness is consumed.

/** The placeholder the input box shows while it is empty: in normal mode, and in shell mode. */
const INPUT_PROMPTS = ["Type your message or @path/to/file", "Type your shell command"];

/** The sign-in choice, the API key prompt, and the wait for a browser sign-in. */
const SIGN_IN_SCREENS = ["How would you like to authenticate for this project?", "Enter Gemini API Key", "Waiting for authentication"];

const TRUST_DIALOG = "Do you trust the files in this folder?";

export function assessGeminiScreen(input: { paneCommand: string | null; paneContent: string }): NativeResumeProbeResult {
  const { paneCommand, paneContent } = input;

  // First, because Gemini draws inline: after it exits, its last frame (even a sign-in screen) stays above the shell prompt.
  if (paneCommand && SHELL_COMMANDS.has(paneCommand)) {
    return { status: "failed", code: "returned_to_shell", detail: "The pane is at a shell prompt, so the Gemini CLI is not running." };
  }
  if (SIGN_IN_SCREENS.some((text) => paneContent.includes(text))) {
    return {
      status: "attention_required",
      code: "login_required",
      detail: "The Gemini CLI is asking you to sign in or give it an API key. Attach to the session and finish that, or sign in once with `gemini` so the seats can reuse it.",
    };
  }
  if (paneContent.includes(TRUST_DIALOG)) {
    return { status: "inconclusive", code: "trust_gate", detail: "The Gemini CLI is asking whether to trust this folder. Answer in the session." };
  }
  if (INPUT_PROMPTS.some((text) => paneContent.includes(text))) {
    return { status: "resumed", code: "active_runtime", detail: "The Gemini CLI is waiting for input." };
  }
  return { status: "inconclusive", code: "awaiting_runtime", detail: "The Gemini CLI has not shown its input prompt yet." };
}
