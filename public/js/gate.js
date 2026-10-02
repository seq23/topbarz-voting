// The gate: the popup on a voter's first like, comment or share. The action that opened it is
// held, and applied the moment the gate lets the voter in. Closing it cancels that action; the
// page stays usable. The markup is in index.html (so its copy can be proofread by a test).
//
// Two steps in the one popup. DETAILS: email, name, city. Then, when the server emails a code
// (`verification: "code_sent"`), CODE: the 6-digit code, a way to change the email, and a resend
// control that counts down. Any answer that carries a token (codes off, or `skipped` because no
// code could be sent) lets the voter straight in with no code step. A voter part-way through the
// code step is remembered (api.js: the email, never the code), so a refresh or a closed popup
// comes back to the code step.
import { api, forgetPending, loadPending, savePending } from "./api.js";
import { $, closeModal, showModal } from "./dom.js";
import { codeDigits, gatePayload, heldToKeep, pendingRecord, resendLabel, secondsUntil, validateGate } from "./logic.js";

const FIELDS = ["email", "name", "city"];
const DONE_SHOWN_MS = 900;
const AFTER_CLOSE_MS = 350;
const TITLE = { details: "One quick step to count your vote", code: "Enter the code we emailed you" };
const IDLE = { details: "Count my vote", code: "Check my code" };

// hooks: { onVoter(response), runHeld(action) → Promise<{ ok, done?, after? }>, heldLine(action) → string,
//          codesOn() → boolean (the server says it emails codes),
//          openerFor(action) → the button a held action belongs to (focus returns there) }
export function createGate(hooks) {
  const dialog = $("tbz-gate");
  const form = $("tbz-gate-form");
  const title = $("tbz-gate-title");
  const held = $("tbz-gate-held");
  const alertLine = $("tbz-gate-error");
  const button = $("tbz-gate-submit");
  const buttonText = $("tbz-gate-submit-text");
  const details = $("tbz-gate-details");
  const input = { email: $("tbz-gate-email"), name: $("tbz-gate-name"), city: $("tbz-gate-city") };
  const errorLine = { email: $("tbz-gate-email-error"), name: $("tbz-gate-name-error"), city: $("tbz-gate-city-error") };
  const optIn = $("tbz-gate-optin");
  const honeypot = $("tbz-gate-hp"); // sent as `website`; a person never sees or fills it
  const codeStep = $("tbz-gate-code-step");
  const codeTo = $("tbz-gate-code-to");
  const codeInput = $("tbz-gate-code");
  const codeError = $("tbz-gate-code-error");
  const codeNote = $("tbz-gate-code-note");
  const codeActions = $("tbz-gate-code-actions");
  const resend = $("tbz-gate-resend");
  const change = $("tbz-gate-change");

  let action = null; // the held like / comment / share
  let opener = null;
  let busy = false;
  let request = null;
  let closeTimer = null;
  let afterDone = null; // what follows a finished gate (a held share opens its panel)
  let step = "details";
  let pending = null; // the voter part-way through the code step
  let codeDead = false; // expired or out of tries: only a new code helps
  let lastTried = ""; // the code last sent by itself, so the same wrong digits are not re-sent
  let ticker = null;

  function setButton(state, text) {
    button.dataset.state = state; // idle | working | done | retry
    button.disabled = state === "working" || state === "done" || (step === "code" && codeDead);
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

  function showCodeError(message) {
    codeError.textContent = message || "";
    codeError.hidden = !message;
    if (message) codeInput.setAttribute("aria-invalid", "true");
    else codeInput.removeAttribute("aria-invalid");
  }

  function showCodeNote(message) {
    codeNote.textContent = message || "";
    codeNote.hidden = !message;
  }

  // Once a second on the code step: the resend control counts down, then switches on; and the
  // code's own end is shown the moment it passes.
  function tick() {
    if (step !== "code" || !pending) return;
    const now = Date.now();
    const wait = secondsUntil(pending.resend_at, now);
    const wasOff = resend.disabled;
    resend.disabled = wait > 0 || busy;
    resend.textContent = resendLabel(wait);
    // A dead code leaves one way forward: when its wait ends, the keyboard is put on it.
    if (codeDead && wasOff && !resend.disabled) resend.focus();
    if (!codeDead && !busy && now >= pending.expires_at) endCode("That code has expired. Send a new one.");
  }

  // The code can no longer be used: say so, and point at the one thing that helps.
  function endCode(message) {
    codeDead = true;
    codeInput.value = "";
    codeInput.disabled = true; // a dead code's field takes no typing: only a new code helps
    showCodeNote("");
    showCodeError(message);
    setButton("idle", IDLE.code);
    if (!resend.disabled) resend.focus();
  }

  function showStep(next) {
    step = next;
    clearInterval(ticker);
    ticker = null;
    codeDead = false;
    lastTried = "";
    details.hidden = next !== "details";
    codeStep.hidden = next !== "code";
    codeActions.hidden = next !== "code";
    title.textContent = TITLE[next];
    showAlert("");
    showCodeError("");
    showCodeNote("");
    codeInput.value = "";
    codeInput.disabled = false;
    setButton("idle", IDLE[next]);
    if (next !== "code") return;
    codeTo.textContent = pending.email;
    tick();
    ticker = setInterval(tick, 1000);
  }

  function reset() {
    clearTimeout(closeTimer);
    clearInterval(ticker);
    ticker = null;
    busy = false;
    request = null;
    afterDone = null;
    showFieldErrors({});
  }

  function close() {
    clearTimeout(closeTimer);
    clearInterval(ticker);
    ticker = null;
    closeModal(dialog);
    const back = opener;
    opener = null;
    if (back?.isConnected) back.focus({ preventScroll: true });
  }

  // The voter is in and the "done" state has been shown (or was closed early).
  function finish() {
    const after = afterDone;
    afterDone = null;
    busy = false;
    close();
    // Closing takes the popup's entry out of the history (dom.js); what follows (a held share
    // hands over to the phone's Messages) waits for that, so the two never cross.
    if (after) setTimeout(after, AFTER_CLOSE_MS);
  }

  // Close button, Escape, or a tap outside: the held action is dropped. A code already sent
  // stays good: the next like, comment or share opens the code step again.
  function dismiss() {
    if (button.dataset.state === "done") return finish();
    request?.abort();
    action = null;
    busy = false;
    if (pending) { pending = { ...pending, held: null, dismissed: true }; savePending(pending); }
    close();
  }

  // The server answered with a token (the code was right, codes are off, or no code could be
  // sent). Remember the voter, then the held like / comment goes out; the button stays "working"
  // until it has landed.
  async function letIn(data, mine) {
    hooks.onVoter(data);
    forgetPending();
    pending = null;
    form.reset(); // the email is not left in the page for the next person at this screen
    const heldAction = action;
    action = null;
    const result = heldAction ? await hooks.runHeld(heldAction) : { ok: true, done: "You’re in" };
    if (mine.signal.aborted) return;
    if (!result.ok) { busy = false; close(); return; } // the card itself says what went wrong
    setButton("done", result.done || "You’re in");
    afterDone = result.after || null;
    closeTimer = setTimeout(finish, DONE_SHOWN_MS);
  }

  function fillDetails(from) {
    input.email.value = from.email;
    input.name.value = from.name;
    input.city.value = from.city;
    optIn.checked = from.marketing_opt_in === true;
  }

  // Back to the details step with what was typed, so only the email needs fixing.
  function changeDetails() {
    if (busy || !pending) return;
    const typed = pending;
    forgetPending();
    pending = null;
    showStep("details");
    fillDetails(typed);
    input.email.focus();
    input.email.select();
  }

  // POST /api/voters: the first ask from the details step, or a new code from the code step.
  async function ask(payload, working) {
    const resending = step === "code";
    busy = true;
    showAlert("");
    showCodeNote("");
    setButton("working", working);
    tick();
    request = new AbortController();
    const mine = request;
    try {
      const { data } = await api("/api/voters", { method: "POST", body: payload, signal: mine.signal });
      if (mine.signal.aborted) return;
      if (data.verification !== "code_sent") { await letIn(data, mine); return; }
      pending = pendingRecord(payload, data, Date.now(), action);
      savePending(pending);
      form.reset();
      busy = false;
      showStep("code");
      if (resending && data.sent !== false) showCodeNote("A new code is on its way.");
      codeInput.focus();
    } catch (err) {
      if (err.code === "cancelled" || mine.signal.aborted) return;
      busy = false;
      if (resending && !err.extra?.fields) {
        // Asked too soon or too often: the server says when a new code can be asked for.
        const retry = Number(err.extra?.retry_after_seconds);
        if (retry > 0 && (err.code === "resend_cooldown" || err.code === "code_limit")) {
          pending = { ...pending, resend_at: Date.now() + retry * 1000 };
          savePending(pending);
        }
        setButton("idle", IDLE.code);
        showAlert(err.message);
        tick();
        return;
      }
      if (resending) { // the email itself was refused: back to the details, filled in
        const typed = pending;
        forgetPending();
        pending = null;
        showStep("details");
        fillDetails(typed);
      }
      const firstField = err.extra?.fields ? showFieldErrors(err.extra.fields) : null;
      setButton("retry", "Try again");
      // A browser's autofill can write into the hidden field. Empty it, so a person's retry goes through.
      if (err.code === "rejected") honeypot.value = "";
      if (firstField) firstField.focus();
      else showAlert(err.message);
    }
  }

  const againPayload = () => ({ name: pending.name, email: pending.email, city: pending.city, marketing_opt_in: pending.marketing_opt_in, website: "" });

  // POST /api/voters/verify: the code step's submit.
  async function checkCode() {
    if (codeDead || !pending) return;
    const code = codeDigits(codeInput.value);
    showAlert("");
    showCodeNote("");
    if (code.length < 6) { showCodeError("Enter the 6-digit code from the email."); codeInput.focus(); return; }
    busy = true;
    lastTried = code;
    showCodeError("");
    setButton("working", "Checking…");
    tick();
    request = new AbortController();
    const mine = request;
    try {
      const { data } = await api("/api/voters/verify", { method: "POST", body: { email: pending.email, code }, signal: mine.signal });
      if (mine.signal.aborted) return;
      await letIn(data, mine);
    } catch (err) {
      if (err.code === "cancelled" || mine.signal.aborted) return;
      busy = false;
      // Codes were switched off while this one was awaited: the details alone now let the voter in.
      if (err.code === "verification_off") { await ask(againPayload(), "Counting…"); return; }
      setButton("idle", IDLE.code);
      tick();
      if (err.code === "code_expired" || err.code === "code_exhausted") endCode(err.message);
      else if (err.code === "wrong_code" || err.code === "invalid_code") { showCodeError(err.message); codeInput.focus(); codeInput.select(); }
      else showAlert(err.message);
    }
  }

  async function submit(ev) {
    ev.preventDefault();
    if (busy) return;
    if (step === "code") { await checkCode(); return; }
    const values = { name: input.name.value, email: input.email.value, city: input.city.value, optIn: optIn.checked, website: honeypot.value };
    showAlert("");
    const firstBad = showFieldErrors(validateGate(values));
    if (firstBad) { setButton("idle", IDLE.details); firstBad.focus(); return; }
    await ask(gatePayload(values), hooks.codesOn?.() ? "Sending your code…" : "Counting…");
  }

  form.addEventListener("submit", submit);
  for (const name of FIELDS) {
    input[name].addEventListener("input", () => {
      if (!input[name].hasAttribute("aria-invalid")) return;
      input[name].removeAttribute("aria-invalid");
      errorLine[name].hidden = true;
    });
  }
  // Typed, pasted or filled in by the phone from the email: digits only, and the sixth one sends it.
  codeInput.addEventListener("input", () => {
    const digits = codeDigits(codeInput.value);
    if (codeInput.value !== digits) codeInput.value = digits;
    if (!codeDead) showCodeError("");
    return digits.length === 6 && digits !== lastTried && !busy && !codeDead ? checkCode() : undefined;
  });
  resend.addEventListener("click", () => {
    if (busy || !pending || secondsUntil(pending.resend_at, Date.now()) > 0) return undefined;
    return ask(againPayload(), "Sending a new code…");
  });
  change.addEventListener("click", changeDetails);
  $("tbz-gate-close").addEventListener("click", dismiss);
  dialog.addEventListener("cancel", (ev) => { ev.preventDefault(); dismiss(); });
  dialog.addEventListener("click", (ev) => { if (ev.target === dialog) dismiss(); });
  dialog.addEventListener("keydown", (ev) => { if (ev.key === "Escape" && typeof dialog.showModal !== "function") dismiss(); });

  function open(heldAction, from, note = "") {
    if (dialog.open) return;
    reset();
    action = heldAction;
    opener = from || document.activeElement;
    held.textContent = hooks.heldLine(heldAction);
    pending = loadPending();
    if (pending) { pending = { ...pending, held: heldToKeep(heldAction), dismissed: false }; savePending(pending); }
    showStep(pending ? "code" : "details");
    showAlert(note);
    showModal(dialog, dismiss);
    if (pending && codeDead && !resend.disabled) resend.focus();
    else (pending ? codeInput : input.email).focus();
  }

  return {
    // note: an extra line when the voter is being asked again (their saved sign-in stopped working).
    open,
    // After a reload part-way through the code step (a phone often reloads the tab while the
    // voter reads the email): straight back to the code step, with the held like or share.
    // Not when the voter closed the popup themselves, and not once the code has run out.
    resume() {
      if (dialog.open) return false;
      const waiting = loadPending();
      if (!waiting || waiting.dismissed || Date.now() >= waiting.expires_at) return false;
      open(waiting.held, hooks.openerFor?.(waiting.held) || null);
      return true;
    },
    isOpen: () => dialog.open,
  };
}
