import { StatusBar } from "@/components/layout/StatusBar";
import { TitleBar } from "@/components/layout/TitleBar";
import { PreviewPane } from "@/components/preview/PreviewPane";
import { TimelinePanel } from "@/components/timeline/TimelinePanel";
import { TransportBar } from "@/components/transport/TransportBar";
import { TooltipProvider } from "@/components/ui/tooltip";
import { usePlaybackStore } from "@/features/playback";

export function AppShell() {
  const runtimeBrowserDurationSeconds = usePlaybackStore(
    (state) => state.runtimeBrowserDurationSeconds,
  );
  const seekApproximate = usePlaybackStore((state) => state.seekApproximate);

  return (
    <TooltipProvider delayDuration={300}>
      <div className="flex h-screen w-screen flex-col overflow-hidden bg-background text-foreground select-none">
        <TitleBar />
        <PreviewPane />
        <TransportBar />
        <TimelinePanel
          runtimeBrowserDurationSeconds={runtimeBrowserDurationSeconds}
          onApproximateSeek={seekApproximate}
        />
        <StatusBar />
      </div>
    </TooltipProvider>
  );
}
