"use client";

import { useState, useRef } from "react";
import {
  Sparkle,
  Copy,
  Check,
  UploadSimple,
  Scissors,
  Cube,
  DownloadSimple,
  WarningCircle,
  Info,
  ArrowsClockwise,
  Sliders,
  CaretRight,
  Lightbulb,
  ArrowsLeftRight,
  DotsSixVertical,
  HandGrabbing,
  ArrowsOutCardinal,
} from "@phosphor-icons/react";
import { Viewport3D, CameraAngle, ShadingMode } from "./Viewport3D";

export type LiteStep = "guide_prompt" | "upload_calibrate" | "review_tiles" | "synthesize_3d";

export interface LiteModeViewProps {
  apiBase: string;
  isDark: boolean;
  currentStep?: LiteStep;
  onStepChange?: (step: LiteStep) => void;
  onSwitchToStudio?: (projectId?: string) => void;
  activeProjectId?: string | null;
  onSelectProject?: (id: string) => void;
  onAssetUpdated?: (asset: any, stage: string, projectId: string) => void;
}

interface SheetAnalysis {
  width: number;
  height: number;
  aspect_ratio: number;
  is_square: boolean;
  is_white_bg: boolean;
  mean_border_brightness: number;
  suggested_center_x: number;
  suggested_center_y: number;
  quadrants: Record<
    string,
    {
      bbox: number[];
      local_bbox: number[];
      subject_height: number;
      subject_width: number;
      coverage_pct: number;
      has_subject: boolean;
    }
  >;
  height_consistency_score: number;
  warnings: string[];
}

interface TileMeta {
  key: string;
  url: string;
  expected_view: string;
  assigned_view: "front" | "left" | "back" | "right" | "disabled";
  coverage_ratio: number;
  components_kept: number;
}

export function LiteModeView({
  apiBase,
  isDark,
  currentStep: externalStep,
  onStepChange,
  onSwitchToStudio,
  activeProjectId,
  onSelectProject,
  onAssetUpdated,
}: LiteModeViewProps) {
  // Navigation step (controlled by parent if provided, otherwise internal)
  const [internalStep, setInternalStep] = useState<LiteStep>("guide_prompt");
  const currentStep = externalStep ?? internalStep;
  const setCurrentStep = (s: LiteStep) => {
    if (onStepChange) onStepChange(s);
    else setInternalStep(s);
  };

  // Step 1: Prompt Builder State (Simple for ChatGPT & Gemini)
  const [characterDesc, setCharacterDesc] = useState("chú robot chibi bằng gốm sứ có trái tim phát sáng");
  const [promptLanguage, setPromptLanguage] = useState<"vi" | "en">("vi");
  const [copiedPrompt, setCopiedPrompt] = useState(false);

  // Step 2: Upload & Interactive Canvas State
  const [projectId, setProjectId] = useState<string>(activeProjectId || "");
  const [sheetUrl, setSheetUrl] = useState<string | null>(null);
  const [analysis, setAnalysis] = useState<SheetAnalysis | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [centerX, setCenterX] = useState(0.5);
  const [centerY, setCenterY] = useState(0.5);
  const [trimMargin, setTrimMargin] = useState(0.02);
  const [autoNormalizeHeight, setAutoNormalizeHeight] = useState(true);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const [isDraggingCrosshair, setIsDraggingCrosshair] = useState(false);

  // Step 3: Review Tiles with Drag & Drop
  const [tiles, setTiles] = useState<TileMeta[]>([]);
  const [draggedTileIdx, setDraggedTileIdx] = useState<number | null>(null);
  const [dragOverTileIdx, setDragOverTileIdx] = useState<number | null>(null);
  const [isSlicing, setIsSlicing] = useState(false);
  const [octreeRes, setOctreeRes] = useState<number>(320);
  const [inferenceSteps, setInferenceSteps] = useState<number>(10);
  const [targetHeightMm, setTargetHeightMm] = useState<number>(80.0);
  const [taubinSmooth, setTaubinSmooth] = useState<number>(2);

  // Step 4: 3D Synthesis State
  const [isGenerating, setIsGenerating] = useState(false);
  const [genProgress, setGenProgress] = useState(0);
  const [genMessage, setGenMessage] = useState("");
  const [glbUrl, setGlbUrl] = useState<string | null>(null);
  const [stlUrl, setStlUrl] = useState<string | null>(null);
  const [shading, setShading] = useState<ShadingMode>("clay");
  const [cameraAngle, setCameraAngle] = useState<CameraAngle>("orbit");
  const [autoRotate, setAutoRotate] = useState(true);
  const [stlDownloadName, setStlDownloadName] = useState("model.stl");
  const [glbDownloadName, setGlbDownloadName] = useState("model.glb");

  // Format backend URL
  const toUrl = (path: string | null | undefined) => {
    if (!path) return "";
    if (path.startsWith("http://") || path.startsWith("https://") || path.startsWith("blob:")) return path;
    const clean = path.startsWith("/") ? path : `/${path}`;
    return `${apiBase}${clean}`;
  };

  // Concise single prompt optimized for ChatGPT & Gemini
  const getPromptForAI = () => {
    if (promptLanguage === "vi") {
      return `Tạo một bức ảnh turnaround sheet 2x2 vuông (tỉ lệ 1:1) trên nền trắng tinh khiết (#FFFFFF) của: ${characterDesc}.
Bố cục hiển thị đúng 4 góc nhìn của cùng một nhân vật:
- Góc trên trái: Nhìn thẳng chính diện (Front view)
- Góc trên phải: Nhìn nghiêng sang trái (Left side profile)
- Góc dưới trái: Nhìn từ sau lưng (Back view)
- Góc dưới phải: Nhìn nghiêng sang phải (Right side profile)
Quy chuẩn bắt buộc:
1. Cùng một nhân vật, 4 góc nhìn phải cùng chiều cao và tỉ lệ, dáng đứng thẳng A-pose đối xứng.
2. Nền trắng hoàn toàn (#FFFFFF), ánh sáng studio dịu, không bóng đổ trên sàn, không bục đứng.
3. Tuyệt đối KHÔNG viết bất kỳ chữ nào (không ghi "front", "side", "back") và KHÔNG vẽ đường kẻ viền chia ô.`;
    }
    return `Create a single square 1:1 turnaround sheet of ${characterDesc} on a solid pure flat white background (#FFFFFF).
The image has a 2x2 grid showing 4 views of the exact same character with identical height and scale:
- Top-Left: Front view (facing forward, 0 degrees)
- Top-Right: Left side profile view (90 degrees)
- Bottom-Left: Back view (180 degrees)
- Bottom-Right: Right side profile view (270 degrees)
Rules:
1. Identical character scale and height across all four panels, neutral A-pose standing firmly flat-footed.
2. Pure solid white background everywhere, soft studio lighting, zero floor shadows, no ground plane, no pedestals.
3. Absolutely NO text labels anywhere, NO captions, NO dividing lines, clean 3D character design sheet.`;
  };

  const handleCopyPrompt = () => {
    navigator.clipboard.writeText(getPromptForAI());
    setCopiedPrompt(true);
    setTimeout(() => setCopiedPrompt(false), 2000);
  };

  // Canvas Mouse Dragging Handlers for interactive crosshair positioning
  const updateCrosshairFromClient = (clientX: number, clientY: number) => {
    const el = canvasRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const x = Math.max(0.2, Math.min(0.8, (clientX - rect.left) / rect.width));
    const y = Math.max(0.2, Math.min(0.8, (clientY - rect.top) / rect.height));
    setCenterX(parseFloat(x.toFixed(2)));
    setCenterY(parseFloat(y.toFixed(2)));
  };

  const handleCanvasPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    setIsDraggingCrosshair(true);
    updateCrosshairFromClient(e.clientX, e.clientY);
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
  };

  const handleCanvasPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!isDraggingCrosshair) return;
    updateCrosshairFromClient(e.clientX, e.clientY);
  };

  const handleCanvasPointerUp = () => {
    setIsDraggingCrosshair(false);
  };

  // Upload or Demo handler
  const handleFileUpload = async (file: File) => {
    setIsUploading(true);
    try {
      const formData = new FormData();
      formData.append("file", file);
      if (projectId) formData.append("project_id", projectId);
      formData.append("character_name", characterDesc.slice(0, 40));

      const res = await fetch(`${apiBase}/api/lite/upload-sheet`, {
        method: "POST",
        body: formData,
      });
      if (!res.ok) throw new Error("Tải ảnh thất bại");
      const data = await res.json();

      setProjectId(data.project_id);
      if (onSelectProject) onSelectProject(data.project_id);
      setSheetUrl(toUrl(data.sheet_url));
      setAnalysis(data.analysis);
      setCenterX(data.analysis.suggested_center_x || 0.5);
      setCenterY(data.analysis.suggested_center_y || 0.5);
      setCurrentStep("upload_calibrate");
    } catch (err: any) {
      alert(`Lỗi khi tải ảnh: ${err.message}`);
    } finally {
      setIsUploading(false);
    }
  };

  const handleLoadDemo = async () => {
    setIsUploading(true);
    try {
      const formData = new FormData();
      formData.append("demo_asset", "cute_robot");
      formData.append("character_name", "Chibi Cute Robot");

      const res = await fetch(`${apiBase}/api/lite/upload-sheet`, {
        method: "POST",
        body: formData,
      });
      if (!res.ok) throw new Error("Không tải được ảnh mẫu");
      const data = await res.json();

      setProjectId(data.project_id);
      if (onSelectProject) onSelectProject(data.project_id);
      setSheetUrl(toUrl(data.sheet_url));
      setAnalysis(data.analysis);
      setCenterX(data.analysis.suggested_center_x || 0.5);
      setCenterY(data.analysis.suggested_center_y || 0.5);
      setCurrentStep("upload_calibrate");
    } catch (err: any) {
      alert(`Lỗi: ${err.message}`);
    } finally {
      setIsUploading(false);
    }
  };

  // Slice sheet
  const handleSliceSheet = async () => {
    if (!projectId) return;
    setIsSlicing(true);
    try {
      const res = await fetch(`${apiBase}/api/lite/slice`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          project_id: projectId,
          center_x: centerX,
          center_y: centerY,
          trim_ratio: trimMargin,
          auto_normalize_heights: autoNormalizeHeight,
        }),
      });
      if (!res.ok) throw new Error("Lỗi xử lý cắt và tách nền");
      const data = await res.json();

      const mapped: TileMeta[] = (data.tiles || []).map((t: any) => ({
        key: t.key,
        url: toUrl(t.url),
        expected_view: t.expected_view,
        assigned_view: t.expected_view as any,
        coverage_ratio: t.coverage_ratio,
        components_kept: t.components_kept,
      }));

      setTiles(mapped);
      setCurrentStep("review_tiles");
    } catch (err: any) {
      alert(`Lỗi khi cắt ảnh: ${err.message}`);
    } finally {
      setIsSlicing(false);
    }
  };

  // Drag & drop swap handlers between the 4 tiles
  const handleTileDragStart = (e: React.DragEvent, index: number) => {
    e.dataTransfer.setData("text/plain", index.toString());
    setDraggedTileIdx(index);
  };

  const handleTileDragOver = (e: React.DragEvent, index: number) => {
    e.preventDefault();
    if (dragOverTileIdx !== index) {
      setDragOverTileIdx(index);
    }
  };

  const handleTileDrop = (e: React.DragEvent, targetIndex: number) => {
    e.preventDefault();
    const sourceIndex = parseInt(e.dataTransfer.getData("text/plain"), 10);
    if (!isNaN(sourceIndex) && sourceIndex !== targetIndex) {
      setTiles((prev) => {
        const next = [...prev];
        const temp = next[sourceIndex];
        next[sourceIndex] = next[targetIndex];
        next[targetIndex] = temp;
        // Standard view assignment by slot: 0=front, 1=left, 2=back, 3=right
        const slotViews: ("front" | "left" | "back" | "right")[] = ["front", "left", "back", "right"];
        return next.map((t, i) => ({
          ...t,
          assigned_view: t.assigned_view === "disabled" ? "disabled" : slotViews[i] || t.assigned_view,
        }));
      });
    }
    setDraggedTileIdx(null);
    setDragOverTileIdx(null);
  };

  // Quick swap Left and Right
  const handleSwapLeftRight = () => {
    setTiles((prev) =>
      prev.map((t) => {
        if (t.assigned_view === "left") return { ...t, assigned_view: "right" };
        if (t.assigned_view === "right") return { ...t, assigned_view: "left" };
        return t;
      })
    );
  };

  // Start 3D Generation
  const handleStart3DGeneration = async () => {
    if (!projectId) return;
    setIsGenerating(true);
    setGenProgress(10);
    setGenMessage("Đang lưu cấu hình góc nhìn và thiết lập 3D...");
    setCurrentStep("synthesize_3d");

    try {
      // 1. Configure 3D view mapping
      const viewMapping: Record<string, string> = {};
      tiles.forEach((t) => {
        if (t.assigned_view !== "disabled") {
          viewMapping[t.assigned_view] = t.key;
        }
      });

      const configRes = await fetch(`${apiBase}/api/lite/configure-3d`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          project_id: projectId,
          character_name: characterDesc.slice(0, 40),
          view_mapping: viewMapping,
          octree_resolution: octreeRes,
          num_inference_steps: inferenceSteps,
          target_height_mm: targetHeightMm,
          taubin_smooth_iterations: taubinSmooth,
        }),
      });

      if (!configRes.ok) throw new Error("Không thể lưu cấu hình 3D");

      setGenProgress(25);
      setGenMessage("Đang chạy mô hình Hunyuan3D-2mv trên Apple Silicon MPS (Local)...");

      // 2. Stream generation via SSE (100% Local Apple Silicon MPS)
      const genRes = await fetch(`${apiBase}/api/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt: `Lite 3D Asset: ${characterDesc}`,
          mode: "live",
          from_step: 5,
          to_step: 5,
          project_id: projectId,
          device: "mps",
        }),
      });

      if (!genRes.ok) throw new Error("Lỗi kích hoạt tiến trình dựng 3D");

      const reader = genRes.body?.getReader();
      if (!reader) throw new Error("Không đọc được luồng SSE");

      const decoder = new TextDecoder("utf-8");
      let buffer = "";

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (line.startsWith("data: ")) {
            try {
              const eventData = JSON.parse(line.substring(6));
              if (eventData.progress !== undefined) {
                setGenProgress(Math.max(25, eventData.progress));
              }
              if (eventData.message) {
                setGenMessage(eventData.message);
              }
              if (eventData.asset?.urls) {
                if (eventData.asset.urls.glb) {
                  setGlbUrl(toUrl(eventData.asset.urls.glb));
                  setGlbDownloadName(`${eventData.asset.asset_name || "model"}.glb`);
                }
                if (eventData.asset.urls.stl) {
                  setStlUrl(toUrl(eventData.asset.urls.stl));
                  setStlDownloadName(`${eventData.asset.asset_name || "model"}.stl`);
                }
              }
            } catch {
              // ignore json parse chunk errors
            }
          }
        }
      }

      // Check final asset status
      const assetRes = await fetch(`${apiBase}/api/projects/${projectId}`);
      if (assetRes.ok) {
        const assetData = await assetRes.json();
        const urls = assetData.asset?.urls || {};
        if (urls.glb) setGlbUrl(toUrl(urls.glb));
        if (urls.stl) setStlUrl(toUrl(urls.stl));
        if (assetData.asset) {
          onAssetUpdated?.(assetData.asset, "complete", projectId);
        }
      }

      setGenProgress(100);
      setGenMessage("Hoàn thành! Mô hình 3D sẵn sàng.");
    } catch (err: any) {
      alert(`Lỗi dựng hình 3D: ${err.message}`);
      setGenMessage("Dựng hình gặp lỗi. Vui lòng thử lại hoặc kiểm tra kết nối GPU.");
    } finally {
      setIsGenerating(false);
    }
  };

  return (
    <div className="mx-auto flex w-full max-w-[1400px] flex-col gap-6 px-6 py-4">
      {/* STEP 1: HƯỚNG DẪN & BỘ SINH PROMPT CHUẨN */}
      {currentStep === "guide_prompt" && (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
          {/* Left Column: Visual Guide & Standards */}
          <div className="lg:col-span-5 flex flex-col gap-4">
            <div className="rounded-2xl border border-zinc-200/80 bg-white p-5 shadow-sm dark:border-zinc-800/80 dark:bg-zinc-900">
              <h3 className="flex items-center gap-2 text-sm font-semibold text-zinc-900 dark:text-zinc-100 mb-2">
                <Lightbulb size={18} weight="fill" className="text-amber-500" />
                Tiêu Chuẩn Cho Ảnh 2x2 Turnaround
              </h3>
              <p className="text-xs text-zinc-500 dark:text-zinc-400 mb-4">
                Mô hình 3D đẹp phụ thuộc vào ảnh đầu vào. Đảm bảo ảnh sinh ra từ ChatGPT / Gemini thỏa mãn sơ đồ:
              </p>

              {/* Visual Diagram: DO (Correct Layout) */}
              <div className="rounded-xl border border-emerald-500/30 bg-emerald-50/50 p-3.5 dark:bg-emerald-950/20 mb-4">
                <div className="flex items-center justify-between mb-2">
                  <span className="flex items-center gap-1.5 text-xs font-bold text-emerald-700 dark:text-emerald-400">
                    <Check size={14} weight="bold" /> CHUẨN: Lưới 2x2 Cân Xứng
                  </span>
                  <span className="text-[10px] font-mono text-emerald-600 dark:text-emerald-500 bg-white dark:bg-zinc-800 px-1.5 py-0.5 rounded border border-emerald-500/20">
                    1:1 Vuông
                  </span>
                </div>

                {/* SVG Visual Illustration of Correct 2x2 Sheet */}
                <div className="relative mx-auto w-full max-w-[280px] aspect-square rounded-lg border-2 border-dashed border-emerald-400 bg-white p-2 dark:bg-zinc-800">
                  {/* Alignment guide lines */}
                  <div className="absolute top-[28%] left-2 right-2 border-b border-sky-400/50 border-dotted z-10">
                    <span className="absolute -top-3 right-0 text-[8px] text-sky-600 font-mono">Dóng Đầu</span>
                  </div>
                  <div className="absolute top-[80%] left-2 right-2 border-b border-sky-400/50 border-dotted z-10">
                    <span className="absolute -top-3 right-0 text-[8px] text-sky-600 font-mono">Dóng Chân</span>
                  </div>

                  {/* 2x2 Divider lines */}
                  <div className="absolute inset-x-0 top-1/2 border-t border-zinc-200 dark:border-zinc-700" />
                  <div className="absolute inset-y-0 left-1/2 border-l border-zinc-200 dark:border-zinc-700" />

                  {/* 4 Quadrants labels & silhouettes */}
                  <div className="grid grid-cols-2 grid-rows-2 h-full gap-2 text-center">
                    <div className="flex flex-col items-center justify-center rounded bg-zinc-50 p-1 dark:bg-zinc-900/60">
                      <span className="text-[10px] font-bold text-zinc-800 dark:text-zinc-200">1. FRONT (0°)</span>
                      <span className="text-[9px] text-zinc-500">Nhìn thẳng</span>
                      <div className="mt-1 h-12 w-7 rounded-t-lg bg-emerald-500/20 border border-emerald-500/40 flex items-center justify-center text-[9px] font-bold text-emerald-700">A-pose</div>
                    </div>
                    <div className="flex flex-col items-center justify-center rounded bg-zinc-50 p-1 dark:bg-zinc-900/60">
                      <span className="text-[10px] font-bold text-zinc-800 dark:text-zinc-200">2. LEFT (90°)</span>
                      <span className="text-[9px] text-zinc-500">Nghiêng trái</span>
                      <div className="mt-1 h-12 w-6 rounded-t-lg bg-emerald-500/20 border border-emerald-500/40 flex items-center justify-center text-[9px] font-bold text-emerald-700">Profile</div>
                    </div>
                    <div className="flex flex-col items-center justify-center rounded bg-zinc-50 p-1 dark:bg-zinc-900/60">
                      <span className="text-[10px] font-bold text-zinc-800 dark:text-zinc-200">3. BACK (180°)</span>
                      <span className="text-[9px] text-zinc-500">Sau lưng</span>
                      <div className="mt-1 h-12 w-7 rounded-t-lg bg-emerald-500/20 border border-emerald-500/40 flex items-center justify-center text-[9px] font-bold text-emerald-700">Back</div>
                    </div>
                    <div className="flex flex-col items-center justify-center rounded bg-zinc-50 p-1 dark:bg-zinc-900/60">
                      <span className="text-[10px] font-bold text-zinc-800 dark:text-zinc-200">4. RIGHT (270°)</span>
                      <span className="text-[9px] text-zinc-500">Nghiêng phải</span>
                      <div className="mt-1 h-12 w-6 rounded-t-lg bg-emerald-500/20 border border-emerald-500/40 flex items-center justify-center text-[9px] font-bold text-emerald-700">Profile</div>
                    </div>
                  </div>
                </div>
              </div>

              {/* Visual Diagram: DON'T (Common Pitfalls) */}
              <div className="rounded-xl border border-rose-500/30 bg-rose-50/50 p-3.5 dark:bg-rose-950/20">
                <span className="flex items-center gap-1.5 text-xs font-bold text-rose-700 dark:text-rose-400 mb-1.5">
                  <WarningCircle size={14} weight="bold" /> Lưu Ý Khi Gen Ảnh:
                </span>
                <ul className="text-xs text-rose-800/90 dark:text-rose-300/90 space-y-1 list-disc list-inside">
                  <li><strong>Không chữ:</strong> Không ghi chú "Front", "Side", "Back" vào ảnh.</li>
                  <li><strong>Nền trắng thuần #FFFFFF:</strong> Không đổ bóng sàn, không bục đứng.</li>
                  <li><strong>Cùng chiều cao:</strong> 4 góc nhân vật phải cùng tỉ lệ đầu - chân.</li>
                </ul>
              </div>
            </div>
          </div>

          {/* Right Column: Simple Prompt Studio for ChatGPT & Gemini */}
          <div className="lg:col-span-7 flex flex-col gap-4">
            <div className="rounded-2xl border border-zinc-200/80 bg-white p-5 shadow-sm dark:border-zinc-800/80 dark:bg-zinc-900">
              <div className="flex items-center justify-between mb-3">
                <div>
                  <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100 flex items-center gap-2">
                    <Sparkle size={16} weight="fill" className="text-amber-500" />
                    Prompt Tạo Ảnh Cho ChatGPT & Gemini
                  </h3>
                  <p className="text-xs text-zinc-500 dark:text-zinc-400">
                    Chỉ cần gõ mô tả nhân vật, bấm sao chép và dán trực tiếp vào ChatGPT hoặc Gemini.
                  </p>
                </div>

                {/* Language Switcher */}
                <div className="flex items-center gap-1 rounded-lg bg-zinc-100 p-1 dark:bg-zinc-800">
                  <button
                    type="button"
                    onClick={() => setPromptLanguage("vi")}
                    className={`rounded px-2.5 py-1 text-xs font-medium transition-all ${
                      promptLanguage === "vi"
                        ? "bg-white text-zinc-900 shadow-xs dark:bg-zinc-700 dark:text-zinc-100"
                        : "text-zinc-500 hover:text-zinc-900 dark:text-zinc-400"
                    }`}
                  >
                    Tiếng Việt
                  </button>
                  <button
                    type="button"
                    onClick={() => setPromptLanguage("en")}
                    className={`rounded px-2.5 py-1 text-xs font-medium transition-all ${
                      promptLanguage === "en"
                        ? "bg-white text-zinc-900 shadow-xs dark:bg-zinc-700 dark:text-zinc-100"
                        : "text-zinc-500 hover:text-zinc-900 dark:text-zinc-400"
                    }`}
                  >
                    English
                  </button>
                </div>
              </div>

              {/* Character Description Input */}
              <div className="mb-3">
                <label className="block text-xs font-medium text-zinc-700 dark:text-zinc-300 mb-1">
                  Mô tả nhân vật / đồ vật:
                </label>
                <input
                  type="text"
                  value={characterDesc}
                  onChange={(e) => setCharacterDesc(e.target.value)}
                  placeholder="Ví dụ: chú robot chibi bằng gốm sứ có trái tim phát sáng, chú mèo samurai..."
                  className="w-full rounded-xl border border-zinc-300 bg-zinc-50 px-3.5 py-2.5 text-xs text-zinc-900 focus:border-amber-500 focus:bg-white focus:outline-none dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
                />
              </div>

              {/* Quick suggestion chips */}
              <div className="mb-4 flex flex-wrap items-center gap-1.5">
                <span className="text-[11px] text-zinc-400 mr-1">Gợi ý nhanh:</span>
                {[
                  "chú robot chibi bằng gốm sứ có trái tim phát sáng",
                  "chú mèo samurai chibi mặc giáp katana",
                  "chú rồng con dễ thương vảy ngọc",
                  "chiến binh mecha tương lai",
                  "tượng nghệ thuật điêu khắc mini",
                ].map((txt) => (
                  <button
                    key={txt}
                    type="button"
                    onClick={() => setCharacterDesc(txt)}
                    className="rounded-full border border-zinc-200 bg-zinc-50 px-2.5 py-0.5 text-[11px] text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900 dark:border-zinc-800 dark:bg-zinc-800 dark:text-zinc-300"
                  >
                    {txt.split(" ")[1]} {txt.split(" ")[2] || ""}
                  </button>
                ))}
              </div>

              {/* Single Prompt Box for 1-Click Copy */}
              <div className="relative rounded-xl border border-zinc-200 bg-zinc-900 p-4 font-mono text-xs text-zinc-100 dark:border-zinc-800">
                <div className="flex items-center justify-between mb-2.5 pb-2 border-b border-zinc-800">
                  <span className="text-[11px] font-semibold text-amber-400 flex items-center gap-1.5">
                    <Sparkle size={14} weight="fill" />
                    Prompt chuẩn cho ChatGPT / Gemini ({promptLanguage.toUpperCase()}):
                  </span>
                  <button
                    type="button"
                    onClick={handleCopyPrompt}
                    className="flex items-center gap-1.5 rounded-lg bg-amber-500 px-3.5 py-1.5 text-xs font-semibold text-zinc-950 transition-all hover:bg-amber-400 active:scale-95 shadow-sm shadow-amber-500/20"
                  >
                    {copiedPrompt ? <Check size={14} weight="bold" /> : <Copy size={14} weight="bold" />}
                    <span>{copiedPrompt ? "Đã Sao Chép!" : "Sao Chép Prompt"}</span>
                  </button>
                </div>
                <p className="whitespace-pre-wrap leading-relaxed text-zinc-300 max-h-[170px] overflow-y-auto pr-2">
                  {getPromptForAI()}
                </p>
              </div>

              {/* Action Buttons to Next Step */}
              <div className="mt-5 flex items-center justify-between pt-4 border-t border-zinc-100 dark:border-zinc-800">
                <button
                  type="button"
                  onClick={handleLoadDemo}
                  disabled={isUploading}
                  className="flex items-center gap-2 rounded-xl border border-zinc-300 px-3.5 py-2 text-xs font-medium text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
                >
                  <Sparkle size={14} className="text-amber-500" />
                  <span>Dùng Ảnh Mẫu (Cute Robot Demo)</span>
                </button>

                <button
                  type="button"
                  onClick={() => setCurrentStep("upload_calibrate")}
                  className="flex items-center gap-2 rounded-xl bg-gradient-to-r from-amber-500 to-orange-500 px-5 py-2.5 text-xs font-semibold text-white shadow-md shadow-orange-500/20 hover:from-amber-600 hover:to-orange-600 active:scale-95"
                >
                  <span>Đã Có Ảnh, Sang Bước Tải Ảnh</span>
                  <CaretRight size={14} weight="bold" />
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ========================================================================= */}
      {/* STEP 2: TẢI ẢNH & CĂN CHỈNH TRỰC TIẾP BẰNG CHUỘT TRÊN PREVIEW              */}
      {/* ========================================================================= */}
      {currentStep === "upload_calibrate" && (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
          {/* Left Canvas: Interactive Image Splitter (Drag directly on preview) */}
          <div className="lg:col-span-7 flex flex-col gap-4">
            <div className="rounded-2xl border border-zinc-200/80 bg-white p-5 shadow-sm dark:border-zinc-800/80 dark:bg-zinc-900">
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-2">
                  <Scissors size={18} className="text-sky-500" />
                  <div>
                    <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
                      Căn Chỉnh Trực Tiếp Trên Preview
                    </h3>
                    <span className="text-[11px] text-zinc-500 block">
                      Dùng chuột nhấp hoặc kéo rê trực tiếp trên ảnh để đổi vị trí tâm cắt
                    </span>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      if (analysis) {
                        setCenterX(analysis.suggested_center_x);
                        setCenterY(analysis.suggested_center_y);
                      } else {
                        setCenterX(0.5);
                        setCenterY(0.5);
                      }
                    }}
                    className="flex items-center gap-1 rounded-lg border border-zinc-200 bg-zinc-50 px-2.5 py-1 text-xs text-zinc-600 hover:bg-zinc-100 dark:border-zinc-800 dark:bg-zinc-800 dark:text-zinc-300"
                  >
                    <ArrowsClockwise size={12} />
                    <span>Tự Động Căn Tâm</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    className="flex items-center gap-1 rounded-lg bg-sky-500 px-3 py-1 text-xs font-medium text-white hover:bg-sky-600"
                  >
                    <UploadSimple size={12} weight="bold" />
                    <span>Chọn Ảnh Khác</span>
                  </button>
                </div>
              </div>

              {/* Upload Dropzone if no image yet */}
              {!sheetUrl ? (
                <div
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={(e) => {
                    e.preventDefault();
                    if (e.dataTransfer.files && e.dataTransfer.files[0]) {
                      handleFileUpload(e.dataTransfer.files[0]);
                    }
                  }}
                  className="flex flex-col items-center justify-center rounded-2xl border-2 border-dashed border-zinc-300 bg-zinc-50/60 p-12 text-center dark:border-zinc-700 dark:bg-zinc-850/40"
                >
                  <div className="mb-3 flex h-14 w-14 items-center justify-center rounded-full bg-sky-50 text-sky-500 dark:bg-sky-950/40">
                    <UploadSimple size={28} />
                  </div>
                  <h4 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
                    Kéo thả ảnh Turnaround Sheet 2x2 vào đây
                  </h4>
                  <p className="mt-1 text-xs text-zinc-500 max-w-sm">
                    Hỗ trợ file PNG, JPG, WebP. Tỉ lệ 1:1 vuông (1024x1024 hoặc 2048x2048) cho kết quả tốt nhất.
                  </p>
                  <div className="mt-4 flex items-center gap-3">
                    <button
                      type="button"
                      onClick={() => fileInputRef.current?.click()}
                      disabled={isUploading}
                      className="rounded-xl bg-sky-500 px-4 py-2 text-xs font-semibold text-white shadow-sm hover:bg-sky-600 active:scale-95"
                    >
                      {isUploading ? "Đang xử lý..." : "Chọn file từ máy tính"}
                    </button>
                    <span className="text-xs text-zinc-400">hoặc</span>
                    <button
                      type="button"
                      onClick={handleLoadDemo}
                      disabled={isUploading}
                      className="rounded-xl border border-zinc-300 bg-white px-3.5 py-2 text-xs font-medium text-zinc-700 hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300"
                    >
                      Thử ảnh mẫu Demo
                    </button>
                  </div>
                </div>
              ) : (
                /* Interactive Canvas with Direct Mouse Dragging Support */
                <div
                  ref={canvasRef}
                  onPointerDown={handleCanvasPointerDown}
                  onPointerMove={handleCanvasPointerMove}
                  onPointerUp={handleCanvasPointerUp}
                  className={`relative mx-auto w-full max-w-[500px] aspect-square rounded-xl overflow-hidden border border-zinc-300 bg-zinc-100 dark:border-zinc-700 dark:bg-zinc-800 select-none shadow-inner cursor-crosshair touch-none ${
                    isDraggingCrosshair ? "ring-2 ring-sky-500" : ""
                  }`}
                  title="Nhấp hoặc kéo rê chuột trực tiếp trên ảnh để đổi vị trí tâm cắt 2x2"
                >
                  {/* Background Sheet Image */}
                  <img
                    src={sheetUrl}
                    alt="Turnaround Sheet"
                    draggable={false}
                    className="h-full w-full object-contain pointer-events-none select-none"
                  />

                  {/* Vertical Split Line */}
                  <div
                    className="absolute inset-y-0 w-1 -translate-x-1/2 bg-sky-500 shadow-md shadow-sky-500/60 z-20 cursor-ew-resize hover:w-1.5 transition-all"
                    style={{ left: `${centerX * 100}%` }}
                  />

                  {/* Horizontal Split Line */}
                  <div
                    className="absolute inset-x-0 h-1 -translate-y-1/2 bg-sky-500 shadow-md shadow-sky-500/60 z-20 cursor-ns-resize hover:h-1.5 transition-all"
                    style={{ top: `${centerY * 100}%` }}
                  />

                  {/* Draggable Center Point Handle */}
                  <div
                    className="absolute -translate-x-1/2 -translate-y-1/2 z-30 flex h-7 w-7 items-center justify-center rounded-full bg-sky-500 text-white shadow-xl shadow-sky-500/60 cursor-grab active:cursor-grabbing border-2 border-white hover:scale-110 transition-transform"
                    style={{ left: `${centerX * 100}%`, top: `${centerY * 100}%` }}
                    title="Kéo rê tâm cắt"
                  >
                    <ArrowsOutCardinal size={15} weight="bold" />
                  </div>

                  {/* 4 Quadrant Overlay Badges */}
                  <div className="absolute top-2 left-2 z-10 rounded bg-zinc-900/80 px-2 py-0.5 text-[10px] font-bold text-white backdrop-blur pointer-events-none">
                    Top-Left: Front (0°)
                  </div>
                  <div className="absolute top-2 right-2 z-10 rounded bg-zinc-900/80 px-2 py-0.5 text-[10px] font-bold text-white backdrop-blur pointer-events-none">
                    Top-Right: Left (90°)
                  </div>
                  <div className="absolute bottom-2 left-2 z-10 rounded bg-zinc-900/80 px-2 py-0.5 text-[10px] font-bold text-white backdrop-blur pointer-events-none">
                    Bottom-Left: Back (180°)
                  </div>
                  <div className="absolute bottom-2 right-2 z-10 rounded bg-zinc-900/80 px-2 py-0.5 text-[10px] font-bold text-white backdrop-blur pointer-events-none">
                    Bottom-Right: Right (270°)
                  </div>

                  {/* Floating coordinate helper pill */}
                  <div className="absolute bottom-3 left-1/2 -translate-x-1/2 z-30 rounded-full bg-zinc-950/80 px-3 py-1 text-[11px] font-mono text-white backdrop-blur shadow border border-zinc-700 pointer-events-none">
                    Tâm cắt: X {Math.round(centerX * 100)}% | Y {Math.round(centerY * 100)}% (kéo chuột trên ảnh để đổi)
                  </div>
                </div>
              )}

              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                className="hidden"
                onChange={(e) => {
                  if (e.target.files && e.target.files[0]) {
                    handleFileUpload(e.target.files[0]);
                  }
                }}
              />
            </div>
          </div>

          {/* Right Column: Computer Vision Analysis & Calibration Controls */}
          <div className="lg:col-span-5 flex flex-col gap-4">
            <div className="rounded-2xl border border-zinc-200/80 bg-white p-5 shadow-sm dark:border-zinc-800/80 dark:bg-zinc-900">
              <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100 mb-3 flex items-center gap-2">
                <Sparkle size={16} weight="fill" className="text-amber-500" />
                Kiểm Tra & Căn Chỉnh
              </h3>

              {analysis ? (
                <div className="space-y-3">
                  {/* Quality Checklist Cards */}
                  <div className="grid grid-cols-2 gap-2">
                    <div className="rounded-xl border border-zinc-200/80 bg-zinc-50 p-2.5 dark:border-zinc-800 dark:bg-zinc-800/60">
                      <span className="text-[10px] text-zinc-500 block">Kích thước & Tỉ lệ</span>
                      <span className="text-xs font-semibold text-zinc-900 dark:text-zinc-100">
                        {analysis.width} × {analysis.height} ({analysis.aspect_ratio}:1)
                      </span>
                    </div>

                    <div className="rounded-xl border border-zinc-200/80 bg-zinc-50 p-2.5 dark:border-zinc-800 dark:bg-zinc-800/60">
                      <span className="text-[10px] text-zinc-500 block">Màu nền viền</span>
                      <span className={`text-xs font-semibold ${analysis.is_white_bg ? "text-emerald-600" : "text-amber-600"}`}>
                        {analysis.is_white_bg ? "Trắng thuần #FFFFFF" : "Hơi xám / Cần lọc"}
                      </span>
                    </div>
                  </div>

                  {/* Height Consistency Score */}
                  <div className="rounded-xl border border-zinc-200/80 bg-zinc-50 p-3 dark:border-zinc-800 dark:bg-zinc-800/60">
                    <div className="flex items-center justify-between mb-1.5">
                      <span className="text-xs font-medium text-zinc-700 dark:text-zinc-300">
                        Độ đồng đều chiều cao 4 góc:
                      </span>
                      <span className="text-xs font-bold text-emerald-600 dark:text-emerald-400">
                        {analysis.height_consistency_score}%
                      </span>
                    </div>
                    <div className="h-1.5 w-full rounded-full bg-zinc-200 dark:bg-zinc-700 overflow-hidden">
                      <div
                        className="h-full bg-emerald-500 rounded-full transition-all"
                        style={{ width: `${analysis.height_consistency_score}%` }}
                      />
                    </div>
                  </div>

                  {/* Warnings & Suggestions */}
                  {analysis.warnings.length > 0 && (
                    <div className="rounded-xl border border-amber-500/30 bg-amber-50/50 p-3 dark:bg-amber-950/20">
                      <span className="text-xs font-bold text-amber-700 dark:text-amber-400 flex items-center gap-1 mb-1">
                        <WarningCircle size={14} weight="bold" /> Gợi ý căn chỉnh:
                      </span>
                      <ul className="text-xs text-amber-800/90 dark:text-amber-300/90 space-y-1 list-disc list-inside">
                        {analysis.warnings.map((w, i) => (
                          <li key={i}>{w}</li>
                        ))}
                      </ul>
                    </div>
                  )}

                  {/* Calibration Sliders */}
                  <div className="space-y-3 pt-2">
                    <div>
                      <div className="flex items-center justify-between text-xs text-zinc-600 dark:text-zinc-400 mb-1">
                        <span>Tâm cắt ngang (Center X):</span>
                        <span className="font-mono font-bold text-zinc-900 dark:text-zinc-100">{Math.round(centerX * 100)}%</span>
                      </div>
                      <input
                        type="range"
                        min="0.3"
                        max="0.7"
                        step="0.01"
                        value={centerX}
                        onChange={(e) => setCenterX(parseFloat(e.target.value))}
                        className="w-full accent-sky-500"
                      />
                    </div>

                    <div>
                      <div className="flex items-center justify-between text-xs text-zinc-600 dark:text-zinc-400 mb-1">
                        <span>Tâm cắt dọc (Center Y):</span>
                        <span className="font-mono font-bold text-zinc-900 dark:text-zinc-100">{Math.round(centerY * 100)}%</span>
                      </div>
                      <input
                        type="range"
                        min="0.3"
                        max="0.7"
                        step="0.01"
                        value={centerY}
                        onChange={(e) => setCenterY(parseFloat(e.target.value))}
                        className="w-full accent-sky-500"
                      />
                    </div>

                    <div>
                      <div className="flex items-center justify-between text-xs text-zinc-600 dark:text-zinc-400 mb-1">
                        <span>Độ xén viền (Trim Margin):</span>
                        <span className="font-mono font-bold text-zinc-900 dark:text-zinc-100">
                          {Math.round(trimMargin * 100)}%
                        </span>
                      </div>
                      <input
                        type="range"
                        min="0.0"
                        max="0.08"
                        step="0.005"
                        value={trimMargin}
                        onChange={(e) => setTrimMargin(parseFloat(e.target.value))}
                        className="w-full accent-sky-500"
                      />
                    </div>

                    {/* Auto-Normalize Height Checkbox */}
                    <label className="flex items-start gap-2.5 rounded-xl border border-emerald-500/30 bg-emerald-50/30 p-2.5 dark:bg-emerald-950/10 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={autoNormalizeHeight}
                        onChange={(e) => setAutoNormalizeHeight(e.target.checked)}
                        className="mt-0.5 h-4 w-4 rounded accent-emerald-500"
                      />
                      <div className="text-xs">
                        <span className="font-semibold text-emerald-800 dark:text-emerald-400 block">
                          ⚡️ Tự động cân bằng tỉ lệ chiều cao (Khuyên dùng)
                        </span>
                        <span className="text-zinc-500 text-[11px]">
                          Thuật toán sẽ tự động co giãn nhẹ 4 góc để chiều cao đầu-chân đồng mức, giúp mô hình 3D không bị méo.
                        </span>
                      </div>
                    </label>
                  </div>

                  {/* Proceed to Slice Button */}
                  <div className="pt-4 border-t border-zinc-100 dark:border-zinc-800 flex items-center justify-between">
                    <button
                      type="button"
                      onClick={() => setCurrentStep("guide_prompt")}
                      className="text-xs text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200"
                    >
                      ← Quay lại Prompt
                    </button>

                    <button
                      type="button"
                      onClick={handleSliceSheet}
                      disabled={isSlicing || !sheetUrl}
                      className="flex items-center gap-2 rounded-xl bg-gradient-to-r from-sky-500 to-blue-600 px-5 py-2.5 text-xs font-semibold text-white shadow-md shadow-sky-500/20 hover:from-sky-600 hover:to-blue-700 active:scale-95 disabled:opacity-50"
                    >
                      <Scissors size={14} weight="bold" />
                      <span>{isSlicing ? "Đang cắt & tách nền..." : "Tiến Hành Cắt & Tách Nền ➔"}</span>
                    </button>
                  </div>
                </div>
              ) : (
                <div className="flex flex-col items-center justify-center p-8 text-center text-zinc-400 text-xs">
                  <Info size={24} className="mb-2 text-zinc-300" />
                  <span>Hãy tải ảnh 2x2 lên ở khung bên trái để thuật toán tiến hành phân tích và căn chỉnh.</span>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ========================================================================= */}
      {/* STEP 3: REVIEW 4 GÓC NHÌN & KÉO THẢ ĐỔI VỊ TRÍ                             */}
      {/* ========================================================================= */}
      {currentStep === "review_tiles" && (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
          {/* Left: 4 RGBA Tiles with Drag and Drop Reordering */}
          <div className="lg:col-span-8 flex flex-col gap-4">
            <div className="rounded-2xl border border-zinc-200/80 bg-white p-5 shadow-sm dark:border-zinc-800/80 dark:bg-zinc-900">
              <div className="flex items-center justify-between mb-4">
                <div>
                  <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100 flex items-center gap-2">
                    <Check size={16} weight="bold" className="text-emerald-500" />
                    Review & Kéo Thả Đổi Vị Trí 4 Góc Nhìn
                  </h3>
                  <p className="text-xs text-zinc-500 dark:text-zinc-400">
                    Bạn có thể dùng chuột kéo thả trực tiếp giữa các ô để đổi vị trí, hoặc bấm nút đổi nhanh Trái ⇄ Phải.
                  </p>
                </div>

                <button
                  type="button"
                  onClick={handleSwapLeftRight}
                  className="flex items-center gap-1.5 rounded-lg border border-zinc-300 bg-zinc-50 px-3 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300"
                  title="Hoán đổi nhanh góc Trái và góc Phải"
                >
                  <ArrowsLeftRight size={13} weight="bold" className="text-sky-500" />
                  <span>Đổi vị trí Trái ⇄ Phải</span>
                </button>
              </div>

              {/* 4 Quadrants Grid with Drag and Drop */}
              <div className="grid grid-cols-2 gap-4">
                {tiles.map((tile, idx) => {
                  const isDraggingThis = draggedTileIdx === idx;
                  const isHoveredTarget = dragOverTileIdx === idx;
                  const slotLabels = ["1. FRONT (0°)", "2. LEFT (90°)", "3. BACK (180°)", "4. RIGHT (270°)"];

                  return (
                    <div
                      key={tile.key}
                      draggable={true}
                      onDragStart={(e) => handleTileDragStart(e, idx)}
                      onDragOver={(e) => handleTileDragOver(e, idx)}
                      onDrop={(e) => handleTileDrop(e, idx)}
                      onDragEnd={() => {
                        setDraggedTileIdx(null);
                        setDragOverTileIdx(null);
                      }}
                      className={`flex flex-col rounded-2xl border p-3.5 transition-all select-none cursor-grab active:cursor-grabbing ${
                        isDraggingThis
                          ? "opacity-40 border-dashed border-sky-500 scale-[0.98]"
                          : isHoveredTarget
                            ? "border-2 border-sky-500 ring-4 ring-sky-500/20 bg-sky-50/60 dark:bg-sky-950/40 scale-[1.02]"
                            : tile.assigned_view === "disabled"
                              ? "opacity-50 border-zinc-300 bg-zinc-100 dark:border-zinc-800 dark:bg-zinc-900"
                              : "border-zinc-200/90 bg-white hover:border-zinc-300 dark:border-zinc-800 dark:bg-zinc-850/60 shadow-xs"
                      }`}
                    >
                      {/* Tile Header: Grip Handle + Slot Name + Dropdown */}
                      <div className="flex items-center justify-between mb-2">
                        <div className="flex items-center gap-1.5 text-zinc-500">
                          <DotsSixVertical size={16} className="text-zinc-400 group-hover:text-zinc-600" />
                          <span className="text-[11px] font-bold text-zinc-800 dark:text-zinc-200">
                            {slotLabels[idx] || `Ô #${idx + 1}`}
                          </span>
                        </div>
                        <select
                          value={tile.assigned_view}
                          onChange={(e) => {
                            const val = e.target.value as any;
                            setTiles((prev) =>
                              prev.map((t) => (t.key === tile.key ? { ...t, assigned_view: val } : t))
                            );
                          }}
                          className="rounded-lg border border-zinc-300 bg-zinc-50 px-2 py-0.5 text-xs font-semibold text-zinc-900 focus:outline-none dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
                        >
                          <option value="front">Góc: FRONT (0°)</option>
                          <option value="left">Góc: LEFT (90°)</option>
                          <option value="back">Góc: BACK (180°)</option>
                          <option value="right">Góc: RIGHT (270°)</option>
                          <option value="disabled">🚫 Bỏ qua (Hỏng)</option>
                        </select>
                      </div>

                      {/* Image Preview with Transparent Checkerboard */}
                      <div className="relative aspect-square w-full rounded-xl overflow-hidden border border-zinc-200/80 bg-[repeating-conic-gradient(#e5e7eb_0%_25%,#f3f4f6_0%_50%)] bg-[length:16px_16px] dark:bg-[repeating-conic-gradient(#27272a_0%_25%,#18181b_0%_50%)] flex items-center justify-center p-3">
                        <img
                          src={tile.url}
                          alt={tile.key}
                          draggable={false}
                          className="max-h-full max-w-full object-contain drop-shadow-md pointer-events-none"
                        />
                      </div>

                      {/* Tile Footer: Drag instruction tip */}
                      <div className="mt-2.5 flex items-center justify-between text-[11px] text-zinc-500">
                        <span className="flex items-center gap-1 text-[10px] text-zinc-400">
                          <HandGrabbing size={13} />
                          Kéo thả để đổi ô
                        </span>
                        <span className="text-emerald-600 dark:text-emerald-400 font-medium">
                          ✓ Đã tách nền
                        </span>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>

          {/* Right: 3D Synthesis Hyperparameters */}
          <div className="lg:col-span-4 flex flex-col gap-4">
            <div className="rounded-2xl border border-zinc-200/80 bg-white p-5 shadow-sm dark:border-zinc-800/80 dark:bg-zinc-900">
              <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100 mb-3 flex items-center gap-2">
                <Sliders size={16} className="text-indigo-500" />
                Thiết Lập Tái Tạo 3D
              </h3>

              <div className="space-y-4">
                {/* Octree Resolution Preset */}
                <div>
                  <label className="block text-xs font-medium text-zinc-700 dark:text-zinc-300 mb-1.5">
                    Độ chi tiết lưới (Octree Resolution):
                  </label>
                  <div className="grid grid-cols-3 gap-1.5">
                    {[
                      { res: 256, label: "256 (Nhanh)" },
                      { res: 320, label: "320 (Chuẩn)" },
                      { res: 380, label: "380 (Chi tiết)" },
                    ].map((opt) => (
                      <button
                        key={opt.res}
                        type="button"
                        onClick={() => setOctreeRes(opt.res)}
                        className={`rounded-lg py-1.5 text-xs font-medium transition-all ${
                          octreeRes === opt.res
                            ? "bg-indigo-600 text-white shadow-xs"
                            : "bg-zinc-100 text-zinc-600 hover:bg-zinc-200 dark:bg-zinc-800 dark:text-zinc-300"
                        }`}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Inference Steps Slider */}
                <div>
                  <div className="flex items-center justify-between text-xs text-zinc-600 dark:text-zinc-400 mb-1">
                    <span>Số bước suy luận (Steps):</span>
                    <span className="font-mono font-bold text-zinc-900 dark:text-zinc-100">{inferenceSteps}</span>
                  </div>
                  <input
                    type="range"
                    min="6"
                    max="20"
                    step="1"
                    value={inferenceSteps}
                    onChange={(e) => setInferenceSteps(parseInt(e.target.value))}
                    className="w-full accent-indigo-600"
                  />
                  <div className="flex justify-between text-[10px] text-zinc-400">
                    <span>6 (Tốc độ)</span>
                    <span>10 (Khuyên dùng)</span>
                    <span>20 (Sâu)</span>
                  </div>
                </div>

                {/* Target Height for 3D Printing */}
                <div>
                  <div className="flex items-center justify-between text-xs text-zinc-600 dark:text-zinc-400 mb-1">
                    <span>Chiều cao in thực tế (mm):</span>
                    <span className="font-mono font-bold text-zinc-900 dark:text-zinc-100">{targetHeightMm} mm</span>
                  </div>
                  <input
                    type="range"
                    min="40"
                    max="160"
                    step="5"
                    value={targetHeightMm}
                    onChange={(e) => setTargetHeightMm(parseFloat(e.target.value))}
                    className="w-full accent-indigo-600"
                  />
                </div>

                {/* Taubin Smooth Filter */}
                <div>
                  <div className="flex items-center justify-between text-xs text-zinc-600 dark:text-zinc-400 mb-1">
                    <span>Làm mịn bề mặt (Taubin Smooth):</span>
                    <span className="font-mono font-bold text-zinc-900 dark:text-zinc-100">{taubinSmooth}</span>
                  </div>
                  <input
                    type="range"
                    min="0"
                    max="5"
                    step="1"
                    value={taubinSmooth}
                    onChange={(e) => setTaubinSmooth(parseInt(e.target.value))}
                    className="w-full accent-indigo-600"
                  />
                  <span className="text-[10px] text-zinc-400 block mt-1">
                    Khử răng cưa marching-cubes mà không làm teo thể tích.
                  </span>
                </div>

                {/* Generate 3D Mesh CTA */}
                <div className="pt-4 border-t border-zinc-100 dark:border-zinc-800">
                  <button
                    type="button"
                    onClick={handleStart3DGeneration}
                    className="w-full flex items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-emerald-500 to-teal-600 py-3 text-xs font-bold text-white shadow-lg shadow-emerald-500/25 hover:from-emerald-600 hover:to-teal-700 active:scale-95"
                  >
                    <Cube size={16} weight="bold" />
                    <span>TẠO MÔ HÌNH 3D NGAY (BƯỚC CUỐI)</span>
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ========================================================================= */}
      {/* STEP 4: 3D STUDIO & XUẤT FILE (.STL & .GLB)                                */}
      {/* ========================================================================= */}
      {currentStep === "synthesize_3d" && (
        <div className="flex flex-col gap-4">
          {/* Progress Banner while generating */}
          {isGenerating && (
            <div className="rounded-2xl border border-indigo-500/30 bg-indigo-50/50 p-4 dark:bg-indigo-950/20 shadow-sm">
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2">
                  <div className="h-3 w-3 rounded-full bg-indigo-500 animate-pulse" />
                  <span className="text-xs font-semibold text-indigo-900 dark:text-indigo-200">
                    {genMessage || "Đang tái tạo mô hình 3D..."}
                  </span>
                </div>
                <span className="font-mono text-xs font-bold text-indigo-600 dark:text-indigo-400">
                  {genProgress}%
                </span>
              </div>
              <div className="h-2 w-full rounded-full bg-indigo-200 dark:bg-indigo-900 overflow-hidden">
                <div
                  className="h-full bg-indigo-600 rounded-full transition-all duration-300"
                  style={{ width: `${genProgress}%` }}
                />
              </div>
            </div>
          )}

          {/* 3D Viewport Studio */}
          <div className="relative h-[560px] w-full rounded-2xl overflow-hidden border border-zinc-200/80 bg-zinc-950 shadow-lg dark:border-zinc-800">
            {glbUrl ? (
              <Viewport3D
                glbUrl={glbUrl}
                shading={shading}
                cameraAngle={cameraAngle}
                isDark={isDark}
                autoRotate={autoRotate}
              />
            ) : (
              <div className="flex h-full w-full flex-col items-center justify-center text-zinc-400">
                <Cube size={48} className="animate-spin text-indigo-500 mb-3" />
                <span className="text-sm font-medium">{genMessage || "Đang tổng hợp lưới đa giác 3D..."}</span>
              </div>
            )}

            {/* Viewport Floating Controls */}
            {glbUrl && (
              <div className="absolute top-4 left-4 z-20 flex items-center gap-1 rounded-xl bg-zinc-900/80 p-1 backdrop-blur border border-zinc-800">
                {(["clay", "studio", "wire"] as const).map((mode) => (
                  <button
                    key={mode}
                    type="button"
                    onClick={() => setShading(mode)}
                    className={`rounded-lg px-2.5 py-1 text-xs font-medium capitalize transition-all ${
                      shading === mode
                        ? "bg-white text-zinc-950 shadow-xs"
                        : "text-zinc-400 hover:text-white"
                    }`}
                  >
                    {mode === "clay" ? "Thạch cao" : mode === "studio" ? "Màu sắc" : "Lưới wireframe"}
                  </button>
                ))}
              </div>
            )}

            {glbUrl && (
              <div className="absolute top-4 right-4 z-20 flex items-center gap-1 rounded-xl bg-zinc-900/80 p-1 backdrop-blur border border-zinc-800">
                {(["orbit", "front", "left", "back", "right"] as const).map((angle) => (
                  <button
                    key={angle}
                    type="button"
                    onClick={() => {
                      setCameraAngle(angle);
                      setAutoRotate(false);
                    }}
                    className={`rounded-lg px-2.5 py-1 text-xs font-medium capitalize transition-all ${
                      cameraAngle === angle
                        ? "bg-indigo-600 text-white"
                        : "text-zinc-400 hover:text-white"
                    }`}
                  >
                    {angle}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Export & Download Bar */}
          {glbUrl && (
            <div className="flex flex-col sm:flex-row items-center justify-between gap-4 rounded-2xl border border-zinc-200/80 bg-white p-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
              <div className="flex items-center gap-2">
                <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-emerald-500/10 text-emerald-600">
                  <Check size={18} weight="bold" />
                </div>
                <div>
                  <h4 className="text-xs font-semibold text-zinc-900 dark:text-zinc-100">
                    Mô hình Watertight Solid đã sẵn sàng
                  </h4>
                  <p className="text-[11px] text-zinc-500">
                    Đáy phẳng Z=0, chuẩn 80mm in 3D không cần sửa lưới.
                  </p>
                </div>
              </div>

              <div className="flex items-center gap-3">
                {onSwitchToStudio && (
                  <button
                    type="button"
                    onClick={() => {
                      if (onSelectProject) onSelectProject(projectId);
                      onSwitchToStudio(projectId);
                    }}
                    className="flex items-center gap-1.5 rounded-xl bg-gradient-to-r from-blue-600 to-indigo-600 px-4 py-2 text-xs font-semibold text-white shadow-sm hover:from-blue-700 hover:to-indigo-700 active:scale-95"
                  >
                    <Cube size={14} weight="bold" />
                    <span>Mở trong Studio (Full View) ➔</span>
                  </button>
                )}

                {stlUrl && (
                  <a
                    href={stlUrl}
                    download={stlDownloadName}
                    className="flex items-center gap-1.5 rounded-xl bg-indigo-600 px-4 py-2 text-xs font-semibold text-white shadow-sm hover:bg-indigo-700 active:scale-95"
                  >
                    <DownloadSimple size={14} weight="bold" />
                    <span>Tải File .STL (In 3D)</span>
                  </a>
                )}

                {glbUrl && (
                  <a
                    href={glbUrl}
                    download={glbDownloadName}
                    className="flex items-center gap-1.5 rounded-xl border border-zinc-300 bg-white px-4 py-2 text-xs font-semibold text-zinc-800 hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-200 active:scale-95"
                  >
                    <DownloadSimple size={14} weight="bold" />
                    <span>Tải File .GLB (Màu)</span>
                  </a>
                )}

                <button
                  type="button"
                  onClick={() => {
                    setCurrentStep("guide_prompt");
                    setSheetUrl(null);
                    setAnalysis(null);
                    setTiles([]);
                    setGlbUrl(null);
                    setStlUrl(null);
                  }}
                  className="rounded-xl border border-zinc-200 px-3 py-2 text-xs font-medium text-zinc-600 hover:bg-zinc-100 dark:border-zinc-800 dark:text-zinc-400"
                >
                  Tạo Mẫu Khác
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
