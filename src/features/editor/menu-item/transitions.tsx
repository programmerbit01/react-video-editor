import { ScrollArea } from "@/components/ui/scroll-area";
import { TRANSITIONS } from "../data/transitions";
import { ITransition } from "@designcombo/types";
import useStore from "../store/use-store";
import { getStateManagerRef } from "../utils/state-manager-ref";
import { Trash2 } from "lucide-react";

export const Transitions = () => {
  const { transitionsMap } = useStore();
  const appliedList = Object.values(transitionsMap as Record<string, ITransition>);

  return (
    <div className="flex flex-1 flex-col gap-4 py-4 max-h-full">
      {/* Instruction */}
      <div className="mx-4 rounded-lg bg-muted/40 px-3 py-2.5 text-xs text-muted-foreground leading-relaxed">
        Click the{" "}
        <span className="inline-block h-3 w-3 rotate-45 border border-white/60 bg-white/10 align-middle" />{" "}
        diamond between two clips on the timeline to add a transition.
      </div>

      {/* Applied transitions list */}
      {appliedList.length > 0 && (
        <div className="px-4">
          <p className="mb-2 text-xs font-semibold text-muted-foreground uppercase tracking-wide">
            Applied ({appliedList.length})
          </p>
          <div className="flex flex-col gap-1.5">
            {appliedList.map((t) => (
              <AppliedTransitionRow key={t.id} transition={t} />
            ))}
          </div>
        </div>
      )}

      {/* All available transitions grid */}
      <div className="px-4">
        <p className="mb-2 text-xs font-semibold text-muted-foreground uppercase tracking-wide">
          Available
        </p>
        <ScrollArea className="flex-1 max-h-[420px]">
          <div className="grid gap-2 [grid-template-columns:repeat(auto-fit,minmax(80px,1fr))]">
            {TRANSITIONS.slice(1).map((transition) => (
              <TransitionPreviewCard key={transition.id} transition={transition} />
            ))}
          </div>
        </ScrollArea>
      </div>
    </div>
  );
};

const TransitionPreviewCard = ({
  transition,
}: {
  transition: (typeof TRANSITIONS)[number];
}) => (
  <div className="flex flex-col items-center gap-1 rounded-md p-1.5 text-center opacity-70">
    <img
      src={transition.preview}
      alt={transition.name || transition.kind}
      className="h-[70px] w-[70px] rounded-md object-cover"
      draggable={false}
    />
    <span className="w-full truncate text-[11px] capitalize text-muted-foreground">
      {transition.name || transition.kind}
    </span>
  </div>
);

const AppliedTransitionRow = ({ transition }: { transition: ITransition }) => {
  const { trackItemsMap } = useStore();
  const fromClip = (trackItemsMap as any)[transition.fromId];
  const toClip = (trackItemsMap as any)[transition.toId];
  const preview = TRANSITIONS.find(
    (t) =>
      t.kind === transition.kind &&
      ((t as any).direction ?? null) === (transition.direction ?? null)
  )?.preview;

  const handleRemove = () => {
    const sm = getStateManagerRef();
    if (!sm) return;
    const state = sm.getState();
    const filteredIds = state.transitionIds.filter((id: string) => id !== transition.id);
    const filteredMap = { ...state.transitionsMap };
    delete filteredMap[transition.id];
    sm.updateState({
      transitionIds: filteredIds,
      transitionsMap: filteredMap,
    } as any);
  };

  const fromName = String(fromClip?.details?.name || fromClip?.name || "Clip").slice(0, 14);
  const toName = String(toClip?.details?.name || toClip?.name || "Clip").slice(0, 14);

  return (
    <div className="group flex items-center gap-2 rounded-md border border-border/50 bg-muted/30 px-2.5 py-2">
      {preview && (
        <img
          src={preview}
          alt={transition.name || transition.kind}
          className="h-8 w-8 shrink-0 rounded object-cover"
          draggable={false}
        />
      )}
      <div className="min-w-0 flex-1">
        <p className="truncate text-xs font-medium capitalize">
          {transition.name || transition.kind}
        </p>
        <p className="truncate text-[10px] text-muted-foreground">
          {fromName} → {toName}
        </p>
      </div>
      <button
        type="button"
        onClick={handleRemove}
        className="shrink-0 text-muted-foreground opacity-0 hover:text-destructive group-hover:opacity-100 transition-opacity"
        title="Remove transition"
      >
        <Trash2 size={12} />
      </button>
    </div>
  );
};

export default Transitions;
