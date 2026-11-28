// Every word of copy on the engineer's page (/booth), in ONE place: edit this object and nothing else.
//   {name} in `uploading` becomes the file's name. The page's elements are empty in booth.html.
export const COPY = {
  headline: "Hand back a track",
  intro: "Drop the finished file here. You get a code to give the artist: they enter it at voting.topbarz.xyz/track to hear and download their track.",
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
  logTeamOnly: "This list is for the signed-in team. Each code still shows above as its upload finishes.",
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
  // The song being recorded now, the whole group (Scooter, 19 Nov 2026: "show the completed
  // recording's group names from the booth queue so the engineer can confirm the right group").
  recordingNow: "Recording now: {names}. The song goes to all of them once nobody of it is in the booth.",
  inBooth: "in the booth",
  outOfBooth: "out",
  groupsNone: "Nobody is at the upload station yet. When the ambassador taps the last person of a recording out of the booth, their names show here within a few seconds.",
  // Before the file goes up: the engineer confirms the names, on the page.
  confirmGroup: "Upload {file} for {names}?",
  confirmGroupNote: "Check these are the people who recorded it. The song goes to every one of them, and each of them can open it with the code.",
  confirmGroupGo: "Yes, it's them",
  confirmGroupNo: "Not them",
  // "Not them" and "Wait for the names" HOLD the file on this page (Scooter, 20 Nov 2026: "the file
  // waits until the right recording pops up, the engineer confirms the names, and only then it
  // attaches - never quietly attaching to whoever shows up next"). Nothing goes up while it is held;
  // when a recording (or different names) shows above, the page asks again, and only Yes uploads.
  confirmGroupHeld: "Holding {file}. Nothing is uploaded. Ask the ambassador to fix who is on this recording on the team page: when the names change, this page asks you again.",
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
  walkUpHeld: "Holding {file}. Nothing is uploaded. When the ambassador taps the last person of the recording out of the booth, their names show above and this page asks you to confirm them. Only your Yes uploads it.",
  heldForget: "Forget this file",
  heldAgain: "Held until this recording showed.",
  groupsNote: "Upload an MP3 export if you can: it plays fast on phones on the bar's Wi-Fi.",
  sessionGone: "The upload station changed since this page looked, so nothing was uploaded. Holding {file}: this page asks you again with the names now at the station.",
};
