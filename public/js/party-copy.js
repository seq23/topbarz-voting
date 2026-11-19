// The holiday party's shared words (Scooter, 17 Nov 2026, and his revision list of 18 Nov: "Event
// names use "&": Dick & Jane's and Blitz & Bubbles", "Remove the prize line for now", "Remove the
// "Voting ends Friday, December 18" line ... I'll confirm the real cutoff date and time before
// anything counts down or closes"). No prize and no end date is shown until he sends them. The partner logos are white versions of the marks Scooter sent (scripts/make-partner-logos.mjs),
// sized by visual weight rather than one shared height (his note: 20 to 46 px each, none reading
// bigger than the rest), in one row under "in partnership with".
export const HOLIDAY = {
  title: "Top Barz Christmas Party",
  // The dates (Scooter, 18 Nov 2026): the party is Sunday, December 13. The end of voting is NOT set
  // (his later note the same day: the December 18 line "was placeholder text"): nothing shows an end
  // date, nothing counts down and nothing closes (PARTY_VOTING_ENDS_AT in functions/_lib/config.js).
  dates: {
    party: "Sunday, December 13",
  },
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
