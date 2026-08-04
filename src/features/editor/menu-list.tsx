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
import { BarChart2, Sparkles, Globe } from "lucide-react";

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
    id: "stock",
    icon: Icons.video,
    label: "Stock",
    ariaLabel: "Stock media — video, images, audio",
    color: "text-rose-300"
  },
  {
    id: "web",
    icon: Globe,
    label: "Web",
    ariaLabel: "Web & news search — live material via Dify",
    color: "text-teal-300"
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
    id: "graphics",
    icon: BarChart2,
    label: "Graphics",
    ariaLabel: "Add animated charts and graphics",
    color: "text-purple-300"
  },
  {
    id: "motionGraphics",
    icon: Sparkles,
    label: "Motion",
    ariaLabel: "Add animated Lottie motion graphics",
    color: "text-amber-300"
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
        "flex min-w-0 flex-1 cursor-pointer flex-col items-center justify-center gap-0.5 rounded-lg px-0.5 py-1 transition-all duration-200",
        isActive
          ? "bg-foreground/10 text-foreground shadow-[inset_0_1px_0_rgba(127,127,127,0.08)]"
          : "text-muted-foreground hover:bg-foreground/5 hover:text-foreground"
      )}
      key={item.id}
    >
      <Tooltip delayDuration={10}>
        <TooltipTrigger asChild>
          <div
            className={cn(
              "flex h-6 w-6 items-center justify-center rounded-md transition-colors",
              isActive ? "text-foreground" : `${item.color}`
            )}
          >
            <IconComponent width={15} height={15} />
          </div>
        </TooltipTrigger>
        <TooltipContent side="bottom" align="center" sideOffset={4}>
          {item.label}
        </TooltipContent>
      </Tooltip>
      <span className="truncate text-[9px] leading-none">{item.label}</span>
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
      <div className="relative flex items-center border-b border-border/70 bg-primary/7 px-1.5 py-1">
        <div className="flex w-full items-center justify-between gap-0.5">
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
