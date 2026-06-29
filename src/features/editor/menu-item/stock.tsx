import { Archival } from "./archival";

// Stock tab = one unified multi-source search:
//   Row 1: source checkboxes (Pexels, Openverse, Wikimedia, Internet Archive)
//   Row 2: format (Video / Images / Sound)
// No separate sub-tabs — pick sources + format and search.
export const Stock = () => {
  return (
    <div className="flex flex-1 flex-col min-h-0 overflow-hidden">
      <Archival />
    </div>
  );
};
