import { memo, useCallback } from "react";
import useLayoutStore from "./store/use-layout-store";
import { Icons } from "@/components/shared/icons";
import { cn } from "@/lib/utils";
import { useIsLargeScreen } from "@/hooks/use-media-query";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger
} from "@/components/ui/tooltip";
import useStore from "./store/use-store";

// Define menu items configuration for better maintainability
const MENU_ITEMS = [
  {
    id: "vapp",
    icon: Icons.image,
    label: "Vapp",
    ariaLabel: "Open Vapp media",
    color: "text-sky-300"
  },
  {
    id: "videos",
    icon: Icons.video,
    label: "Video",
    ariaLabel: "Add and manage video content",
    color: "text-rose-300"
  },
  {
    id: "images",
    icon: Icons.image,
    label: "Picture",
    ariaLabel: "Add and manage images",
    color: "text-emerald-300"
  },
  {
    id: "audios",
    icon: Icons.audio,
    label: "Audio",
    ariaLabel: "Add and manage audio content",
    color: "text-yellow-300"
  },
  {
    id: "texts",
    icon: Icons.type,
    label: "Text",
    ariaLabel: "Add and edit text elements",
    color: "text-violet-300"
  },
  {
    id: "transitions",
    icon: Icons.transition,
    label: "Transitions",
    ariaLabel: "Add transition effects",
    color: "text-cyan-300"
  },
  {
    id: "captions",
    icon: Icons.captions,
    label: "Captions",
    ariaLabel: "Add and edit captions",
    color: "text-amber-300"
  },
  {
    id: "ai-voice",
    icon: Icons.volume,
    label: "AI Voice",
    ariaLabel: "Generate AI voice from text",
    color: "text-lime-300"
  },
  {
    id: "sfx",
    icon: Icons.sfx,
    label: "SFX",
    ariaLabel: "Generate SFX from text",
    color: "text-pink-300"
  }
] as const;

// Memoized menu button component for better performance
const MenuButton = memo<{
  item: (typeof MENU_ITEMS)[number];
  isActive: boolean;
  onClick: (menuItem: string) => void;
}>(({ item, isActive, onClick }) => {
  const handleClick = useCallback(() => {
    onClick(item.id);
  }, [item.id, onClick]);

  const IconComponent = item.icon;

  return (
    <div
      onClick={handleClick}
      className={cn(
        "flex min-w-0 flex-1 cursor-pointer flex-col items-center justify-center gap-1.5 rounded-xl px-1 py-2 transition-all duration-200",
        isActive
          ? "bg-white/10 text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.05)]"
          : "text-muted-foreground hover:bg-white/5 hover:text-white"
      )}
      key={item.id}
    >
      <Tooltip delayDuration={10}>
        <TooltipTrigger asChild>
          <div
            className={cn(
              "flex h-9 w-9 items-center justify-center rounded-lg transition-colors",
              isActive ? "bg-white/10 text-white" : `${item.color} bg-transparent`
            )}
          >
            <IconComponent width={20} height={20} />
          </div>
        </TooltipTrigger>
        <TooltipContent side="bottom" align="center" sideOffset={8}>
          {item.label}
        </TooltipContent>
      </Tooltip>
      <span className="truncate text-[10px] font-medium leading-none tracking-[0.01em]">
        {item.label}
      </span>
    </div>
  );
});

MenuButton.displayName = "MenuButton";

// Main MenuList component
function MenuList() {
  const {
    setActiveMenuItem,
    setShowMenuItem,
    activeMenuItem,
    showMenuItem,
    drawerOpen,
    setDrawerOpen
  } = useLayoutStore();
  const clearActiveSelection = useCallback(() => {
    useStore.setState({ activeIds: [] });
    useLayoutStore.setState({ trackItem: null });
  }, []);

  const isLargeScreen = useIsLargeScreen();
  const handleMenuItemClick = useCallback(
    (menuItem: string) => {
      clearActiveSelection();
      setActiveMenuItem(menuItem as any);
      // Use drawer on mobile, sidebar on desktop
      if (!isLargeScreen) {
        setDrawerOpen(true);
      } else {
        setShowMenuItem(true);
      }
    },
    [
      clearActiveSelection,
      isLargeScreen,
      setActiveMenuItem,
      setDrawerOpen,
      setShowMenuItem
    ]
  );

  return (
    <>
      <div className="relative flex items-center border-b border-border/70 bg-primary/7 px-2 py-2">
        <div className="flex w-full items-start justify-between gap-1">
          {MENU_ITEMS.map((item) => {
            const isActive =
              (drawerOpen && activeMenuItem === item.id) ||
              (showMenuItem && activeMenuItem === item.id);
            return (
              <MenuButton
                key={item.id}
                item={item}
                isActive={isActive}
                onClick={handleMenuItemClick}
              />
            );
          })}
        </div>
      </div>
    </>
  );
}

export default memo(MenuList);
