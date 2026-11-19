// Every word of copy on the engineer's page (/booth), in ONE place: edit this object and nothing else.
//   {name} in `uploading` becomes the file's name. The page's elements are empty in booth.html.
export const COPY = {
  headline: "Hand back a track",
  intro: "Drop the finished file here. You get a 4-digit code to give the artist: they enter it at voting.topbarz.xyz/track to hear and download their track.",
  zone: "Drop the file here, or tap to choose",
  zoneHint: "WAV, MP3, M4A, AIFF or FLAC, up to 100 MB",
  uploading: "Uploading {name}",
  doneTitle: "Give the artist this code",
  next: "Next file",
  retry: "Try again",
  failed: "The upload did not go through.",
  notAudio: "That is not an audio file. WAV, MP3, M4A, AIFF or FLAC.",
  tooBig: "That file is over 100 MB.",
  empty: "That file is empty.",
  dailyLimit: "Upload limit reached for today, tell Sequoia",
  rateLimited: "Too many uploads from here. Give it a minute.",
  logTitle: "Today's uploads",
  logEmpty: "Nothing uploaded today yet.",
  logFailed: "The log did not load.",
  // The people (4 Oct 2026): how many entered the code on /track, and whether all opted in to the vote. Never a name.
  nobody: "nobody yet",
  onePerson: "1 person",
  people: "{n} people",
  allIn: "all in",
  // The holiday party (17 Nov 2026, and Scooter's revision list of 18 Nov: "When the engineer
  // uploads, the song attaches to exactly the people marked out for it - no picking groups at
  // upload."). The song goes to the people the ambassador tapped in and out for that recording, the
  // oldest at the upload station first. Shown only while the party is on.
  groupsTitle: "This song goes to",
  queued: "{n} more recording{s} waiting after this one.",
  inBoothNow: "Still in the booth: {names}. They show here once the ambassador taps them out.",
  groupsNone: "Nobody is at the upload station yet. When the ambassador taps the last person of a recording out of the booth, their names show here within a few seconds.",
  // A name the team should look at twice (a test sign-up, or one made long ago). First names only here:
  // the team sees the contact details on the team page.
  flagTest: "looks like a test sign-up",
  flagStale: "signed up a long time ago",
  flagged: "{name}: {why}. If that is not who just recorded, ask the ambassador to fix it on the team page before you upload.",
  // Uploading with nobody at the upload station: asked first, on the page itself (Scooter, 18 Nov
  // 2026: the browser's own pop-up "is easy to miss").
  walkUpConfirm: "Upload with nobody on it? Nobody is at the upload station, so nobody can enter this song in the contest until the team puts its people on it from the team page.",
  walkUpPick: "Wait for the names",
  walkUpGo: "Upload with nobody on it",
  walkUpHeld: "Not uploaded. When the names show above, drop the file again.",
  groupsNote: "Upload an MP3 export if you can: it plays fast on phones on the bar's Wi-Fi.",
  sessionGone: "The upload station changed since this page looked: check whose song it is above, then drop the file again.",
};
