/** Thin line marks for the sidebar's sections, in the text colour (seen: four plain words were hard to tell apart). */
const icon = (paths: string[]) =>
  function Icon() {
    return (
      <svg className="side-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        {paths.map((d) => (
          <path key={d} d={d} />
        ))}
      </svg>
    );
  };

export const BookIcon = icon(["M5 4h9a5 5 0 0 1 5 5v11H10a5 5 0 0 1-5-5z", "M9 9h6", "M9 13h4"]);
export const GalleryIcon = icon(["M4 5h16v14H4z", "M4 16l5-5 4 4 2-2 5 5", "M15.5 9.5h.01"]);
export const KeyIcon = icon(["M8 20a4.5 4.5 0 1 0 0-9 4.5 4.5 0 0 0 0 9z", "M11.2 12.3L20 3.5", "M16.5 7l2.5 2.5", "M14 9.5l2 2"]);
export const ComputerIcon = icon(["M4 5h16v11H4z", "M9 20h6", "M12 16v4"]);
export const GearIcon = icon([
  "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z",
  "M19 12a7 7 0 0 0-.1-1.2l2-1.5-2-3.4-2.3.9a7 7 0 0 0-2-1.2L14.2 3h-4.4l-.4 2.6a7 7 0 0 0-2 1.2l-2.3-.9-2 3.4 2 1.5a7 7 0 0 0 0 2.4l-2 1.5 2 3.4 2.3-.9a7 7 0 0 0 2 1.2l.4 2.6h4.4l.4-2.6a7 7 0 0 0 2-1.2l2.3.9 2-3.4-2-1.5c.07-.4.1-.8.1-1.2z",
]);
