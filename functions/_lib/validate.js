import { NAME_MAX_CHARS } from "./config.js";

// Small on purpose: the common throwaway inboxes. A match on the domain or any parent domain.
export const THROWAWAY_DOMAINS = new Set([
  "mailinator.com", "guerrillamail.com", "guerrillamail.net", "guerrillamail.org", "guerrillamail.info",
  "sharklasers.com", "grr.la", "10minutemail.com", "10minutemail.net", "tempmail.com", "temp-mail.org",
  "temp-mail.io", "tempmail.dev", "tempmailo.com", "yopmail.com", "yopmail.net", "trashmail.com",
  "throwawaymail.com", "getnada.com", "nada.email", "dispostable.com", "maildrop.cc", "mailnesia.com",
  "fakeinbox.com", "mintemail.com", "mohmal.com", "emailondeck.com", "moakt.com", "tmpmail.org",
  "tmpmail.net", "mailcatch.com", "spamgourmet.com", "burnermail.io", "mytemp.email", "tempail.com",
  "inboxkitten.com", "minuteinbox.com", "1secmail.com", "1secmail.net", "1secmail.org", "discard.email",
]);

export function cleanText(value, max) {
  if (typeof value !== "string") return "";
  return value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

// → { email, emailKey } or { error }. Email is lowercased and trimmed before anything else.
export function parseEmail(value) {
  if (typeof value !== "string") return { error: "Enter your email." };
  const email = value.trim().toLowerCase();
  if (!email) return { error: "Enter your email." };
  if (email.length > 254 || !/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/.test(email)) {
    return { error: "That email does not look right. Check it and try again." };
  }
  const [local, domain] = email.split("@");
  if (local.length > 64 || !/\.[a-z]{2,}$/.test(domain)) return { error: "That email does not look right. Check it and try again." };
  const parts = domain.split(".");
  for (let i = 0; i < parts.length - 1; i++) {
    if (THROWAWAY_DOMAINS.has(parts.slice(i).join("."))) return { error: "Use an email you check. Throwaway inboxes cannot vote.", code: "throwaway_email" };
  }
  return { email, emailKey: emailKey(local, domain) };
}

// One account per mailbox: jane+anything@x.com is jane@x.com; Gmail also ignores dots.
function emailKey(local, domain) {
  let l = local.split("+")[0];
  let d = domain;
  if (d === "googlemail.com") d = "gmail.com";
  if (d === "gmail.com") l = l.replace(/\./g, "");
  return `${l || local}@${d}`;
}

// The only part of a voter anyone else ever sees.
export function firstName(name) {
  const first = cleanText(name, NAME_MAX_CHARS).split(" ")[0] ?? "";
  return first.slice(0, 30) || "Someone";
}

// A GIF is stored by Giphy id; the URL must be Giphy's own, or we build the plain one from the id.
export function parseGif(gif) {
  if (gif === undefined || gif === null || gif === "") return { gif: null };
  const id = typeof gif === "string" ? gif : gif?.id;
  if (typeof id !== "string" || !/^[A-Za-z0-9]{1,64}$/.test(id)) return { error: "That GIF could not be attached." };
  let url = `https://media.giphy.com/media/${id}/giphy.gif`;
  if (typeof gif === "object" && typeof gif.url === "string" && gif.url.length <= 500) {
    try {
      const u = new URL(gif.url);
      if (u.protocol === "https:" && (u.hostname === "giphy.com" || u.hostname.endsWith(".giphy.com"))) url = u.toString();
    } catch {}
  }
  return { gif: { id, url } };
}
