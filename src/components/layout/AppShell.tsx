import { StatusBar } from "@/components/layout/StatusBar";
import { TitleBar } from "@/components/layout/TitleBar";
import { PreviewPane } from "@/components/preview/PreviewPane";
import { TimelinePanel } from "@/components/timeline/TimelinePanel";
import { TransportBar } from "@/components/transport/TransportBar";
import { TooltipProvider } from "@/components/ui/tooltip";

export function AppShell() {
  return (
    <TooltipProvider delayDuration={300}>
      <div className="flex h-screen w-screen flex-col overflow-hidden bg-background text-foreground select-none">
        <TitleBar />
        <PreviewPane />
        <TransportBar />
        <TimelinePanel />
        <StatusBar />
      </div>
    </TooltipProvider>
  );
}
