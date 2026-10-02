// The gate: the popup on a voter's first like, comment or share. The action that opened it is
// held, and applied the moment the form succeeds. Closing it cancels that action; the page
// stays usable. The markup is in index.html (so its copy can be proofread by a test).
import { api } from "./api.js";
import { $, closeModal, showModal } from "./dom.js";
import { gatePayload, validateGate } from "./logic.js";

const FIELDS = ["email", "name", "city"];
const DONE_SHOWN_MS = 900;

// hooks: { onVoter(response), runHeld(action) → Promise<{ ok, done?, after? }>, heldLine(action) → string }
export function createGate(hooks) {
  const dialog = $("tbz-gate");
  const form = $("tbz-gate-form");
  const held = $("tbz-gate-held");
  const alertLine = $("tbz-gate-error");
  const button = $("tbz-gate-submit");
  const buttonText = $("tbz-gate-submit-text");
  const input = { email: $("tbz-gate-email"), name: $("tbz-gate-name"), city: $("tbz-gate-city") };
  const errorLine = { email: $("tbz-gate-email-error"), name: $("tbz-gate-name-error"), city: $("tbz-gate-city-error") };
  const optIn = $("tbz-gate-optin");
  const honeypot = $("tbz-gate-hp"); // sent as `website`; a person never sees or fills it

  let action = null; // the held like / comment / share
  let opener = null;
  let busy = false;
  let request = null;
  let closeTimer = null;
  let afterDone = null; // what follows a finished gate (a held share opens its panel)

  function setButton(state, text) {
    button.dataset.state = state; // idle | working | done | retry
    button.disabled = state === "working" || state === "done";
    buttonText.textContent = text;
  }

  function showFieldErrors(fields) {
    let first = null;
    for (const name of FIELDS) {
      const message = fields?.[name] || "";
      errorLine[name].textContent = message;
      errorLine[name].hidden = !message;
      if (message) { input[name].setAttribute("aria-invalid", "true"); first ??= input[name]; }
      else input[name].removeAttribute("aria-invalid");
    }
    return first;
  }

  function showAlert(message) {
    alertLine.textContent = message || "";
    alertLine.hidden = !message;
  }

  function reset() {
    clearTimeout(closeTimer);
    busy = false;
    request = null;
    afterDone = null;
    showFieldErrors({});
    showAlert("");
    setButton("idle", "Count my vote");
  }

  function close() {
    clearTimeout(closeTimer);
    closeModal(dialog);
    const back = opener;
    opener = null;
    if (back?.isConnected) back.focus({ preventScroll: true });
  }

  // The form has succeeded and its "done" state has been shown (or was closed early).
  function finish() {
    const after = afterDone;
    afterDone = null;
    busy = false;
    close();
    after?.();
  }

  // Close button, Escape, or a tap outside: the held action is dropped.
  function dismiss() {
    if (button.dataset.state === "done") return finish();
    request?.abort();
    action = null;
    busy = false;
    close();
  }

  async function submit(ev) {
    ev.preventDefault();
    if (busy) return;
    const values = { name: input.name.value, email: input.email.value, city: input.city.value, optIn: optIn.checked, website: honeypot.value };
    showAlert("");
    const firstBad = showFieldErrors(validateGate(values));
    if (firstBad) { setButton("idle", "Count my vote"); firstBad.focus(); return; }

    busy = true;
    setButton("working", "Counting…");
    request = new AbortController();
    const mine = request;
    try {
      const { data } = await api("/api/voters", { method: "POST", body: gatePayload(values), signal: mine.signal });
      if (mine.signal.aborted) return;
      hooks.onVoter(data);
      form.reset(); // the email is not left in the page for the next person at this screen
      const heldAction = action;
      action = null;
      // The held like / comment goes out now; the button stays "working" until it has landed.
      const result = heldAction ? await hooks.runHeld(heldAction) : { ok: true, done: "You're in" };
      if (mine.signal.aborted) return;
      if (!result.ok) { busy = false; close(); return; } // the card itself says what went wrong
      setButton("done", result.done || "You're in");
      afterDone = result.after || null;
      closeTimer = setTimeout(finish, DONE_SHOWN_MS);
    } catch (err) {
      if (err.code === "cancelled" || mine.signal.aborted) return;
      busy = false;
      const firstField = err.extra?.fields ? showFieldErrors(err.extra.fields) : null;
      setButton("retry", "Try again");
      // A browser's autofill can write into the hidden field. Empty it, so a person's retry goes through.
      if (err.code === "rejected") honeypot.value = "";
      if (firstField) firstField.focus();
      else showAlert(err.message);
    }
  }

  form.addEventListener("submit", submit);
  for (const name of FIELDS) {
    input[name].addEventListener("input", () => {
      if (!input[name].hasAttribute("aria-invalid")) return;
      input[name].removeAttribute("aria-invalid");
      errorLine[name].hidden = true;
    });
  }
  $("tbz-gate-close").addEventListener("click", dismiss);
  dialog.addEventListener("cancel", (ev) => { ev.preventDefault(); dismiss(); });
  dialog.addEventListener("click", (ev) => { if (ev.target === dialog) dismiss(); });
  dialog.addEventListener("keydown", (ev) => { if (ev.key === "Escape" && typeof dialog.showModal !== "function") dismiss(); });

  return {
    // note: an extra line when the voter is being asked again (their saved sign-in stopped working).
    open(heldAction, from, note = "") {
      if (dialog.open) return;
      reset();
      action = heldAction;
      opener = from || document.activeElement;
      held.textContent = hooks.heldLine(heldAction);
      showAlert(note);
      showModal(dialog);
      input.email.focus();
    },
    isOpen: () => dialog.open,
  };
}
