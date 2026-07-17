interface ChartSectionNoteProps {
  title?: string;
  items: string[];
}

/** Short, scannable context above a chart group — replaces long single-line hints. */
export function ChartSectionNote({ title, items }: ChartSectionNoteProps) {
  if (items.length === 0) {
    return null;
  }
  return (
    <div className="chart-section-note">
      {title ? <p className="chart-section-note-title">{title}</p> : null}
      <ul>
        {items.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
    </div>
  );
}
