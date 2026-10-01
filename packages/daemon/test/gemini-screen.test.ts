import { describe, expect, it } from "vitest";
import { assessGeminiScreen } from "../src/domain/gemini-screen.js";

// The screens below use the text the Gemini CLI itself draws (google-gemini/gemini-cli, packages/cli/src/ui):
// the input placeholder, the folder trust dialog and the authentication dialogs.
const FRAME = (inner: string) => ["Tips for getting started:", "1. Ask questions, edit files, or run commands.", "", "╭────────────────────╮", inner, "╰────────────────────╯", "~/app (main*)   no sandbox (see /docs)   gemini-2.5-pro"].join("\n");

const READY = FRAME("│ >   Type your message or @path/to/file │");
const SHELL_MODE = FRAME("│ !   Type your shell command │");
const AUTH = ["╭──────────────────╮", "│ ? Get started", "│", "│ How would you like to authenticate for this project?", "│ ● 1. Sign in with Google", "│   2. Use Gemini API Key", "│   3. Vertex AI", "│ (Use Enter to select)", "╰──────────────────╯"].join("\n");
const API_KEY = ["Enter Gemini API Key", "Please enter your Gemini API key.", "Paste your API key here"].join("\n");
const AUTH_WAIT = "⠋ Waiting for authentication... (Press Esc or Ctrl+C to cancel)";
const TRUST = ["Do you trust the files in this folder?", "● 1. Trust folder (app)", "  2. Trust parent folder (work)", "  3. Don't trust"].join("\n");

describe("assessGeminiScreen", () => {
  it("is ready when the input prompt is showing, whatever mode it is in", () => {
    expect(assessGeminiScreen({ paneCommand: "node", paneContent: READY })).toMatchObject({ status: "resumed", code: "active_runtime" });
    expect(assessGeminiScreen({ paneCommand: "node", paneContent: SHELL_MODE })).toMatchObject({ status: "resumed", code: "active_runtime" });
    expect(assessGeminiScreen({ paneCommand: "gemini", paneContent: READY }).status).toBe("resumed");
  });

  it.each([
    ["the sign-in choice", AUTH],
    ["the API key prompt", API_KEY],
    ["the wait for a browser sign-in", AUTH_WAIT],
  ])("needs the person when Gemini is showing %s", (_name, screen) => {
    const result = assessGeminiScreen({ paneCommand: "node", paneContent: screen });

    expect(result).toMatchObject({ status: "attention_required", code: "login_required" });
    expect(result.detail).toContain("Attach to the session");
  });

  it("reports the folder trust dialog as a gate, not as ready", () => {
    expect(assessGeminiScreen({ paneCommand: "node", paneContent: TRUST })).toMatchObject({ status: "inconclusive", code: "trust_gate" });
  });

  it("says Gemini is not running when the pane is back at a shell, even if its last frame is still on screen", () => {
    for (const shell of ["zsh", "bash", "sh", "fish"]) {
      expect(assessGeminiScreen({ paneCommand: shell, paneContent: `${READY}\n$ ` })).toMatchObject({ status: "failed", code: "returned_to_shell" });
    }
    // An old sign-in screen above a shell prompt is not a sign-in request either.
    expect(assessGeminiScreen({ paneCommand: "bash", paneContent: `${AUTH}\n$ ` }).code).toBe("returned_to_shell");
  });

  it("keeps waiting while the input prompt has not appeared yet", () => {
    expect(assessGeminiScreen({ paneCommand: "node", paneContent: "" })).toMatchObject({ status: "inconclusive", code: "awaiting_runtime" });
    expect(assessGeminiScreen({ paneCommand: "node", paneContent: "Loading extensions...\n" }).code).toBe("awaiting_runtime");
    expect(assessGeminiScreen({ paneCommand: null, paneContent: "" }).code).toBe("awaiting_runtime");
  });

  it("does not mistake a banner or tip for the input prompt", () => {
    const banner = "Tips for getting started:\n1. Ask questions, edit files, or run commands.\n2. Be specific for the best results.";
    expect(assessGeminiScreen({ paneCommand: "node", paneContent: banner }).status).toBe("inconclusive");
  });
});
