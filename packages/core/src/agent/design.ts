/**
 * Habits that make every generated interface look alike. The agents are told to avoid them on every step that
 * touches the look.
 */
export const CLICHES = [
  "a blue or violet accent picked by habit (#2563eb, #3b82f6, #6366f1 and the like), or a violet-to-blue gradient",
  "everything in identical white rounded cards with a shadow on a grey background",
  "one dark card in the middle of the screen with a coloured glow",
  "emoji in place of icons",
  "one system font for everything, or a font without Cyrillic for an interface in Russian",
  "a big picture with three feature cards under it as the plan of every home page",
  "grey placeholder boxes and lorem ipsum",
  "a destructive button (delete) louder than the main action",
];

/**
 * Icons and pictures in whatever the agent builds, a ready project or a chat with a folder too (asked for: every currency
 * converter had flags and weather as emoji; Codex drew its icons as SVG).
 */
export const ASSETS_HINT =
  "When you build an interface, never use emoji as icons, bullets, flags or decoration. Take icons from a library: Lucide " +
  "(lucide, lucide-react), Tabler Icons, Phosphor or Heroicons, installed with the project's package manager or pasted as " +
  "their SVG; flags from flag-icons. What no library has (a logo, an illustration, an animated scene) draw yourself as " +
  "SVG, then look at it on the page (browser_look or look_at_page) and fix what looks wrong. Pictures the page needs " +
  "(photos, detailed illustrations): make them with generate_image when you have it, or take " +
  "free photos (Unsplash, Pexels) and save them in the project's assets folder, the source named in README. No grey " +
  "placeholders, and no images linked from other sites at random.";

/**
 * Ambition for whatever the agent builds, with no design brief too (asked for: designs rich and not like every AI-made
 * page; seen: of five weather sites four were plain and alike, and the one he liked had a chart, scenes and gauges).
 */
export const DESIGN_HINT =
  "When you build an interface, do not stop at a plain, safe page unless the user asks for one: make it rich and " +
  "distinctive, as a good product of its kind would be. Give it what such products have beyond the bare request (for a " +
  "weather site, a temperature chart, wind and sun, quick cities; for a shop, filters and a cart that feels alive), data " +
  "shown as charts and gauges where it fits, purposeful motion and micro-interactions, and a palette, fonts with Cyrillic " +
  `and one signature detail that come from the subject, not from habit. Avoid what makes AI-made pages look alike: ${CLICHES.join("; ")}.`;
