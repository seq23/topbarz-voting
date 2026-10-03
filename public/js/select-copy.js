// Every word of copy on the select page (/select), in ONE place: edit this object and nothing else.
// The intro and the three links are Top Barz's own copy (3 Oct 2026, with that morning's update); the rest is ours.
//   intro: parts in order: a plain string, or { text, url } for a linked name (https only, else it
//          shows as plain words). Scooter may swap the two engineer names later: change them here.
//   {name} in pickedTitle becomes the name of the beat that was picked.
//   links: the credits under the beats. `url` https only; "" shows the entry as plain words.
export const COPY = {
  headline: "Pick your beat",
  intro: [
    "These are beats from professional engineers, ",
    { text: "Ayake", url: "https://ayake.base44.app/" },
    " and ",
    { text: "4stro", url: "https://linktr.ee/4stro" },
    ", who have engineered hundreds of sessions with some of your favorite artists like Ice Spice, Jay Gwuapo, Fivio Foreign and the Goo Goo Dolls. This is made possible by our partnership with ",
    { text: "Studio404", url: "https://studio404.nyc/" },
    " located in Brooklyn, NY.",
  ],
  listTitle: "THE BEATS:",
  choose: "Choose this beat",
  chosen: "Your pick",
  pickedTitle: "You picked {name}",
  done: "Remember your pick for when it is your turn in the booth.",
  change: "Change my pick",
  linksTitle: "Engineers and studio",
  links: [
    { role: "Engineer", label: "Ayake", url: "https://ayake.base44.app/" },
    { role: "Engineer", label: "4stro", url: "https://linktr.ee/4stro" },
    { role: "Studio", label: "Studio404, Brooklyn, NY", url: "https://studio404.nyc/" },
  ],
};
