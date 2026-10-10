// Every word of copy on the contest entry page (/entry), in ONE place: edit this object and nothing
// else. These are the working rules (Scooter, 9 Oct 2026: "the final public-facing version will
// follow for go-live"). The thank-you, the contest and the prize are his words. {n} in `memberTitle`
// is the person's place in the list; {name} in `uploading` is the file's name; {entry} in
// `doneEntry` is the entry number. The page's elements are empty in entry.html and filled from here.
export const COPY = {
  headline: "Thank you for jumping in the booth",
  thanks: [
    "We appreciate every one of you. It has been fun watching your recap videos and stories.",
    "If you post a Top Barz recap on your feed, we are open to a collab post with you.",
  ],
  contestTitle: "The contest",
  contest: [
    "Top Barz is hosting a contest. The song voted best from CultureCon wins the prize below.",
    "Voting starts Sunday, October 11, at 10 AM ET.",
  ],
  // The prize, as Scooter wrote it (9 Oct 2026, after the preview).
  prizeTitle: "The prize",
  // One paragraph (Scooter, 9 Oct 2026, second preview); "Studio 404" links to the studio's Instagram.
  prize: {
    before: "The winner gets two hours of studio time at ",
    studio: { text: "Studio 404", href: "https://www.instagram.com/studio404nyc" },
    middle: ", plus one general admission ticket to CultureCon 2027, provided by Top Barz Inc. Winners should email ",
    email: "info@topbarz.xyz",
    after: ".",
  },
  // The only eligibility line on the page; the full restriction is in the official rules (/rules).
  eligibility: "Your track from CultureCon",
  formTitle: "Enter the contest",
  firstName: "First name",
  lastName: "Last name",
  city: "City",
  email: "Email",
  phone: "Phone number",
  groupLabel: "Did you record in a group?",
  yes: "Yes",
  no: "No",
  groupTitle: "Everyone in your group",
  groupHint: "First name, last name and email for each person. Up to 10.",
  memberTitle: "Person {n}",
  add: "Add another",
  remove: "Remove",
  instagram: "Instagram handle(s) (optional)",
  trackTitle: "Title of your track (optional)",
  trackLabel: "Your track",
  zone: "Upload your Top Barz song",
  zoneChosen: "{name}",
  zoneHint: "WAV, MP3, M4A, AIFF or FLAC, up to 100 MB",
  // "I agree to the official rules", with "official rules" linking to /rules (opens in a new tab so a half-filled form is not lost).
  agree: { before: "I agree to the ", link: "official rules", href: "/rules", after: "" },
  faqTitle: "FAQ",
  // The four questions Scooter asked for (9 Oct 2026, second preview), in his order; the group answer is his words. The rest follow.
  faq: [
    { q: "How long is the contest?", a: "Voting starts Sunday, October 11, at 10 AM ET and closes that night at 11:59 PM PT." },
    { q: "What's the prize?", a: "Two hours of studio time at Studio 404, plus one general admission ticket to CultureCon 2027, provided by Top Barz Inc. Winners should email info@topbarz.xyz." },
    { q: "Who can vote?", a: "Anyone with an email address. Each email gets one like per track, and we send a code to confirm it." },
    { q: "What if we recorded in a group?", a: "Please list everyone in the group." },
    { q: "Where are the official rules?", a: "On the official rules page, voting.topbarz.xyz/rules.", link: { text: "Read the official rules", href: "/rules" } },
  ],
  submit: "Enter",
  uploading: "Uploading {name}",
  sending: "Sending your entry",
  doneTitle: "You're in",
  doneEntry: "Your entry number is {entry}. Thank you for jumping in the booth.",
  failed: "Your entry did not go through.",
  retry: "Try again",
  // What the page says before anything is sent (the server checks every one of these again).
  need: {
    first_name: "Enter your first name.",
    last_name: "Enter your last name.",
    city: "Enter your city.",
    email: "Enter an email address that works.",
    phone: "Enter a phone number that works.",
    in_group: "Say whether you recorded in a group.",
    members: "Add the first name, last name and email of everyone in your group.",
    member: "Person {n} in your group needs a first name, a last name and an email address that works.",
    track: "Upload your Top Barz song.",
    agree: "Tick the box to agree to the official rules.",
  },
  notAudio: "That is not an audio file. WAV, MP3, M4A, AIFF or FLAC.",
  tooBig: "That file is over 100 MB.",
  empty: "That file is empty.",
  closed: "Entries have closed.",
  rateLimited: "Too many tries from here. Give it a minute.",
  dailyLimit: "We have reached the upload limit for today. Try again tomorrow.",
};
