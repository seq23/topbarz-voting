// The holiday party's shared words (Scooter, 17 Nov 2026, his revision list of 18 Nov: "Event names
// use "&": Dick & Jane's and Blitz & Bubbles", and his decisions of 19 Nov: "Voting closes Friday,
// November 27 at 11:59pm Eastern. Restore the countdown with the cutoff date and time visible",
// "Use "Prize details TBD" for now"). The partner logos are white versions of the marks Scooter sent (scripts/make-partner-logos.mjs),
// sized by visual weight rather than one shared height (his note: 20 to 46 px each, none reading
// bigger than the rest), in one row under "in partnership with".
export const HOLIDAY = {
  title: "Top Barz Christmas Party",
  // The dates: the party is Sunday, December 13 (18 Nov 2026). Voting closes Friday, November 27 at
  // 11:59 PM Eastern (19 Nov 2026); the moment itself is PARTY_VOTING_ENDS_AT in
  // functions/_lib/config.js, and the page says it in this zone.
  dates: {
    party: "Sunday, December 13",
    zone: "America/New_York",
  },
  // The prize line, Scooter's words until he confirms the terms with the partners (19 Nov 2026).
  prize: "Prize details TBD",
  partnersWith: "in partnership with",
  // height: on a desktop; mobile: on a phone (px). Order as Scooter wrote it.
  partners: [
    { name: "Flow Music", src: "/img/partners/flow-music.png", width: 601, height: 270, desktop: 46, mobile: 38 },
    { name: "Dick & Jane's", src: "/img/partners/dick-and-janes.png", width: 578, height: 270, desktop: 42, mobile: 36 },
    { name: "Blitz & Bubbles", src: "/img/partners/blitz-and-bubbles.png", width: 782, height: 270, desktop: 30, mobile: 26 },
  ],
  // The voting page while the party is on (Scooter's copy direction, 17 Nov 2026).
  home: {
    lede: "Our first-ever Christmas party, Sunday, December 13, hosted at Dick & Jane's in partnership with Flow Music and Blitz & Bubbles. JUMP IN THE BOOTH and make a Christmas jingle. Below are the songs recorded: vote and comment on your favorites.",
    tracksTitle: "THE CHRISTMAS JINGLES:",
    // Under each song's name: who made it (Scooter, 20 Nov 2026). {names} is "Carla & Ken".
    byLine: "by {names}",
    emptyNote: "The jingles are on their way out of the booth. Come back to listen, vote, and send your favorite to your people.",
    // Before voting opens: the party night, no time of day (Scooter, 18 Nov 2026).
    notOpenRefusal: "Voting opens on the party night, Sunday, December 13 (exact time to be confirmed).",
    notOpen: "",
    galleryLabel: "Holiday GIFs and photos from the party",
    photoAlt: "Top Barz Christmas party, photo",
    footMark: "Top Barz",
    pageTitle: "Vote for your favorite Christmas jingle | Top Barz",
    // The page's own words before its script runs, and what a link preview shows (written into the
    // HTML on the server by functions/index.js while the party is on).
    description: "Vote for your favorite Christmas jingle recorded in the Top Barz booth at our first-ever Christmas party, Sunday, December 13, hosted at Dick & Jane's.",
    shareTitle: "Vote for your favorite Christmas jingle | Top Barz",
    shareDescription: "Christmas jingles recorded in the Top Barz booth at Dick & Jane's. Listen, like your favorite, and send it to your people.",
    imageAlt: "Top Barz. JUMP IN THE BOOTH. Vote for your favorite Christmas jingle.",
  },
  off: "Nothing on right now",
  offNote: "The holiday contest is not open yet. Follow Top Barz on Instagram to hear when it is.",
};
HOLIDAY.home.notOpen = `${HOLIDAY.home.notOpenRefusal} You can listen now; likes open then.`;
