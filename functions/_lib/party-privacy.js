// The privacy note while the holiday party is on (/privacy; functions/privacy.js writes it into the
// page). Server-only, so it never weighs on the voting page's scripts. A DRAFT, like /holiday-rules:
// Scooter's final rules pass covers it before go-live.
export const PARTY_PRIVACY = {
  pageTitle: "Privacy note (DRAFT) | Top Barz",
  description: "What the Top Barz Christmas party collects at sign-up and in the vote, why, and who sees it. Draft.",
  html: `<h1>Privacy note</h1>
  <p class="draft-banner" role="note">DRAFT. This note is checked again with the final contest rules before the party goes live.</p>
  <p>This is the Top Barz Christmas party at Dick and Jane's. Here is what we collect when you sign up for the booth and when you vote, and why.</p>
  <h2>When you sign up for the booth</h2>
  <ul>
    <li>Your name, phone number, email and city, and your Instagram if you give it. In a group, each person fills in their own details.</li>
    <li>We use them to run the line, to text you when it is your turn, to put your song with the right people, to run the contest and to reach the winner.</li>
    <li>The signed-in Top Barz team sees your name, phone, email, city and Instagram on the line. A team member texts you from their own phone when it is your turn.</li>
    <li>Your phone and email are never shown on the site. Next to a song, people see first names only.</li>
    <li>Your details stay in this site's own database. They are not sold, shared or added to any mailing list.</li>
  </ul>
  <h2>When you enter a song</h2>
  <ul>
    <li>We keep who ticked "Enter the contest" and when, and which version of the rules was on the page.</li>
    <li>Someone who types a song's code can hear and download it. That does not put them on the song.</li>
  </ul>
  <h2>When you vote</h2>
  <ul>
    <li>Your name, email and city, the first time you like, comment or share, and whether you ticked "Send me Top Barz updates" (it starts unticked).</li>
    <li>We use them to count your vote (one like per song for each email), to email you a 6-digit code so we know the email is yours, to send contest results, to spot unfair voting, and to send updates only if you ticked the box.</li>
    <li>Your first name shows next to a comment you post. Nothing else.</li>
    <li>A scrambled form of your network address limits repeat sign-ups; the address itself is not stored.</li>
  </ul>
  <h2>Other services</h2>
  <ul>
    <li>The site is served by Cloudflare.</li>
    <li>Code emails are sent by Resend, which is given your email address to deliver the code.</li>
    <li>GIFs come from GIPHY: a GIF search is sent to GIPHY, and a GIF loads from GIPHY's servers.</li>
  </ul>
  <h2>Questions, or want your details removed?</h2>
  <p>Message <a href="https://www.instagram.com/topbarz.xyz" rel="noopener">@topbarz.xyz</a> on Instagram.</p>
  <p><a class="btn btn-small" href="/">Back to the vote</a></p>`,
};
