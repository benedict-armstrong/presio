import { Card, CardContent } from "@/components/ui/card";

export function DialogOverlay({
  children,
  onClose,
  maxWidth = "max-w-sm",
}: {
  children: React.ReactNode;
  onClose: () => void;
  maxWidth?: string;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <Card className={`w-full ${maxWidth} max-h-[90dvh] overflow-y-auto`}>
        <CardContent className="pt-6 space-y-4">{children}</CardContent>
      </Card>
    </div>
  );
}
