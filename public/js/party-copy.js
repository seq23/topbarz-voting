// The holiday party's shared words (Scooter, 17 Nov 2026, and his preview notes the same day: "our
// first-ever Christmas party, hosted at Dick and Jane's in partnership with Flow Music and Blitz and
// Bubbles"). The prize is still being finalized: it shows as a marked placeholder, never as a final
// term. The partner logos are white versions of the marks Scooter sent (scripts/make-partner-logos.mjs),
// sized by visual weight rather than one shared height (his note: 20 to 46 px each, none reading
// bigger than the rest), in one row under "in partnership with".
export const HOLIDAY = {
  title: "Top Barz Christmas Party",
  // The dates (Scooter, 18 Nov 2026: "the party is Sunday, December 13, and voting ends Friday,
  // December 18 … I'll confirm the exact cutoff time separately - treat it as unset for now").
  // Written as days only: no cutoff time is shown as if it were set. The preview's countdown runs to
  // the end of that Friday (`npm run party-window`); production's window is set at go-live.
  dates: {
    party: "Sunday, December 13",
    votingEnds: "Friday, December 18",
    timeMark: "exact time to be confirmed",
  },
  partnersWith: "in partnership with",
  // height: on a desktop; mobile: on a phone (px). Order as Scooter wrote it.
  partners: [
    { name: "Flow Music", src: "/img/partners/flow-music.png", width: 601, height: 270, desktop: 46, mobile: 38 },
    { name: "Dick and Jane's", src: "/img/partners/dick-and-janes.png", width: 578, height: 270, desktop: 42, mobile: 36 },
    { name: "Blitz and Bubbles", src: "/img/partners/blitz-and-bubbles.png", width: 782, height: 270, desktop: 30, mobile: 26 },
  ],
  // The voting page while the party is on (Scooter's copy direction, 17 Nov 2026).
  home: {
    lede: "Our first-ever Christmas party, Sunday, December 13, hosted at Dick and Jane's in partnership with Flow Music and Blitz and Bubbles. JUMP IN THE BOOTH and make a Christmas jingle. Below are the songs recorded: vote and comment on your favorites.",
    tracksTitle: "THE CHRISTMAS JINGLES:",
    emptyNote: "The jingles are on their way out of the booth. Come back to listen, vote, and send your favorite to your people.",
    notOpen: "Voting opens soon. You can listen now; likes open then.",
    galleryLabel: "Holiday GIFs and photos from the party",
    photoAlt: "Top Barz Christmas party, photo",
    footMark: "Top Barz",
    pageTitle: "Vote for your favorite Christmas jingle | Top Barz",
    // The page's own words before its script runs, and what a link preview shows (written into the
    // HTML on the server by functions/index.js while the party is on).
    description: "Vote for your favorite Christmas jingle recorded in the Top Barz booth at our first-ever Christmas party, Sunday, December 13, hosted at Dick and Jane's. Voting ends Friday, December 18.",
    shareTitle: "Vote for your favorite Christmas jingle | Top Barz",
    shareDescription: "Christmas jingles recorded in the Top Barz booth at Dick and Jane's. Listen, like your favorite, and send it to your people.",
    imageAlt: "Top Barz. JUMP IN THE BOOTH. Vote for your favorite Christmas jingle.",
    endsPending: "Friday, December 18 (exact time to be confirmed)",
    ruleEndsPending: "Voting ends Friday, December 18 (exact time to be confirmed).",
  },
  // Still being finalized (Scooter: "use a placeholder like this for now, not final terms").
  prize: "The winner wins a bar tab at Dick and Jane's.",
  prizeMark: "Placeholder: the prize is still being finalized",
  off: "Nothing on right now",
  offNote: "The holiday contest is not open yet. Follow Top Barz on Instagram to hear when it is.",
};
