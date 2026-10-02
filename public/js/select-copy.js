// Every word of copy on the select page (/select), in ONE place. These are PLACEHOLDERS: when
// Top Barz sends the real copy and the producer and engineer links, edit this object and nothing
// else (then take the page's noindex off: RUNBOOK.md, "The select page").
//   {name} in pickedTitle becomes the name of the beat that was picked.
//   links: one entry per person. `url` must start with https:// ; while it is "" the entry shows
//   as plain words, not as a link. An empty list hides the whole section.
export const COPY = {
  headline: "Pick your beat",
  intro: "Placeholder intro: listen to each beat, then choose the one you want. The real copy goes here.",
  listTitle: "THE BEATS:",
  choose: "Choose this beat",
  chosen: "Your pick",
  pickedTitle: "You picked {name}",
  done: "Placeholder line: what happens next goes here.",
  change: "Change my pick",
  linksTitle: "Producer and engineer",
  links: [
    { role: "Producer", label: "Producer name and link (placeholder)", url: "" },
    { role: "Engineer", label: "Engineer name and link (placeholder)", url: "" },
  ],
};
