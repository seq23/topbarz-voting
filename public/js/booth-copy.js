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
  // The holiday party (17 Nov 2026): the group in the booth, picked before the upload, so the
  // song knows its people. Shown only while the party is on.
  groupsTitle: "Who is in the booth?",
  groupsNone: "Nobody is marked in the booth on the team page yet. Ask the team to tap In the booth, or upload as a walk-up.",
  walkUp: "No group (a walk-up)",
  groupsNote: "Upload an MP3 export if you can: it plays fast on phones on the bar's Wi-Fi.",
  sessionGone: "That group is not marked in the booth any more. Pick the group again.",
};
