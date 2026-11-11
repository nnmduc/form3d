"use client";

import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import {
  ArrowCounterClockwise,
  ArrowUp,
  CaretDown,
  Check,
  CloudArrowDown,
  Cube,
  DownloadSimple,
  Eye,
  FolderOpen,
  Moon,
  Pause,
  PencilSimple,
  Play,
  Plus,
  Sparkle,
  Sun,
  TrashSimple,
  WarningCircle,
  X,
} from "@phosphor-icons/react";
import type { CameraAngle, ShadingMode } from "./components/Viewport3D";

const Viewport3D = lazy(() =>
  import("./components/Viewport3D").then((m) => ({ default: m.Viewport3D }))
);

export const API_BASE = "http://127.0.0.1:8000";

export function apiUrl(path: string): string {
  const cleanPath = path.startsWith("/") ? path : `/${path}`;
  return `${API_BASE}${cleanPath}`;
}

export function toBackendUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  if (
    url.startsWith("http://") ||
    url.startsWith("https://") ||
    url.startsWith("data:") ||
    url.startsWith("blob:")
  ) {
    return url;
  }
  if (url.startsWith("/projects") || url.startsWith("/outputs") || url.startsWith("/api")) {
    return `${API_BASE}${url}`;
  }
  return url;
}

export type PipelineStage =
  | "idle"
  | "optimizing"
  | "turnaround"
  | "slicing"
  | "reconstructing"
  | "complete";

export interface ProjectItem {
  id: string;
  name: string;
  prompt: string;
  created_at: string;
  updated_at?: string;
  stage: PipelineStage;
  completed_steps: number[];
  has_3d_model?: boolean;
  preview_url?: string | null;
}

export interface SystemStatus {
  status: string;
  agy_installed: boolean;
  agy_path: string | null;
  agy_version: string | null;
  agy_error: string | null;
  models_ready: boolean;
  models?: {
    hunyuan3d_ready: boolean;
    rembg_ready: boolean;
    estimated_total_mb: number;
  };
  device: string;
  colab_url?: string | null;
  projects_dir: string;
}

export interface ColabWorkerStatus {
  ok: boolean;
  configured?: boolean;
  url: string | null;
  latency_ms?: number;
  status?: string;
  ready?: boolean;
  busy?: boolean;
  device?: string;
  gpu_name?: string;
  vram_total_gb?: number;
  vram_free_gb?: number;
  vram_allocated_gb?: number;
  recommended_octree_resolution?: number;
  model_id?: string;
  drive_mounted?: boolean;
  drive_output_dir?: string | null;
  jobs_completed?: number;
  error?: string | null;
}

export interface DownloadProgress {
  status: string;
  message: string;
  progress: number;
  file: string;
  downloaded_mb: number;
  total_mb: number;
}

export interface OrthoTile {
  id: Exclude<CameraAngle, "orbit">;
  label: string;
  angle: string;
  src: string;
  coverage_ratio?: number | null;
  components_kept?: number | null;
  components_total?: number | null;
  verified?: boolean;
}

export interface AssetPayload {
  asset_name: string;
  slug: string;
  stage: PipelineStage;
  completed_steps: number[];
  project_id?: string | null;
  project_name?: string | null;
  urls: {
    sheet: string | null;
    glb: string | null;
    stl: string | null;
    mesh_preview: string | null;
  };
  tiles: OrthoTile[];
  step1?: {
    asset_name?: string;
    character_design_spec?: string;
    turnaround_image_prompt?: string;
    negative_constraints?: string;
  } | null;
  step3?: {
    sheet_size?: [number, number];
    trim_ratio?: number;
  } | null;
  step4?: {
    mesh_3d_prompt?: string;
    octree_resolution?: number;
    num_inference_steps?: number;
    guidance_scale?: number;
    target_height_mm?: number;
    taubin_smooth_iterations?: number;
    qa_notes?: string;
  } | null;
  manifest?: {
    device?: string;
    inference_seconds?: number;
    target_height_mm?: number;
    octree_resolution?: number;
    mesh_stats?: {
      vertices?: number;
      faces?: number;
      is_watertight?: boolean;
      extents_mm?: {
        x_width: number;
        y_depth: number;
        z_height: number;
      };
    };
  } | null;
}

const DEFAULT_ORTHO_TILES: OrthoTile[] = [
  {
    id: "front",
    label: "Front",
    angle: "0°",
    src: "/assets/cute_robot/tiles/tile_tl.png",
    coverage_ratio: 0.4156,
    components_kept: 1,
    components_total: 1,
    verified: true,
  },
  {
    id: "left",
    label: "Left",
    angle: "90°",
    src: "/assets/cute_robot/tiles/tile_tr.png",
    coverage_ratio: 0.291,
    components_kept: 1,
    components_total: 1,
    verified: true,
  },
  {
    id: "back",
    label: "Back",
    angle: "180°",
    src: "/assets/cute_robot/tiles/tile_bl.png",
    coverage_ratio: 0.4201,
    components_kept: 1,
    components_total: 1,
    verified: true,
  },
  {
    id: "right",
    label: "Right",
    angle: "270°",
    src: "/assets/cute_robot/tiles/tile_br.png",
    coverage_ratio: 0.3011,
    components_kept: 1,
    components_total: 1,
    verified: true,
  },
];

const DEFAULT_ROBOT_ASSET: AssetPayload = {
  asset_name: "cute_robot",
  slug: "cute_robot",
  stage: "complete",
  completed_steps: [1, 2, 3, 4, 5],
  urls: {
    sheet: "/assets/cute_robot/sheet.png",
    glb: "/assets/cute_robot/cute_robot.glb",
    stl: "/assets/cute_robot/cute_robot.stl",
    mesh_preview: "/assets/cute_robot/cute_robot_mesh_preview.png",
  },
  tiles: DEFAULT_ORTHO_TILES,
  step1: {
    asset_name: "cute_robot",
    character_design_spec:
      "Compact chibi-proportioned vinyl-toy robot engineered for watertight manifold 3D reconstruction and support-free FDM printing. Rounded-cubic head with fused ear-nodes, recessed facial visor, stout barrel torso with embossed heart badge, dorsal battery pack with circular turbine cooling vent, and flat-soled blocky boots.",
    turnaround_image_prompt:
      "Single square 1:1 (1024x1024) 2x2 orthographic turnaround sheet on pure flat white background: Top-Left Front (0°), Top-Right Left (90°), Bottom-Left Back (180°), Bottom-Right Right (270°).",
  },
  step4: {
    mesh_3d_prompt:
      "Compact chibi-proportioned vinyl-toy cute robot with watertight manifold geometry, recessed visor, chest heart badge, dorsal turbine backpack, and flat-soled boots.",
    octree_resolution: 320,
    num_inference_steps: 10,
    guidance_scale: 5.5,
    target_height_mm: 80,
    taubin_smooth_iterations: 2,
    qa_notes:
      "All 4 RGBA quadrant tiles verified with clean alpha silhouettes and zero floating geometry.",
  },
  manifest: {
    device: "mps",
    inference_seconds: 210.07,
    target_height_mm: 80.0,
    octree_resolution: 320,
    mesh_stats: {
      vertices: 307975,
      faces: 615958,
      is_watertight: true,
      extents_mm: {
        x_width: 70.72,
        y_depth: 44.95,
        z_height: 80.0,
      },
    },
  },
};

const STAGE_ORDER: PipelineStage[] = [
  "idle",
  "optimizing",
  "turnaround",
  "slicing",
  "reconstructing",
  "complete",
];

const STAGE_META: Record<
  PipelineStage,
  {
    shortLabel: string;
    statusText: string;
    progress: number;
  }
> = {
  idle: {
    shortLabel: "Prompt",
    statusText: "Ready",
    progress: 0,
  },
  optimizing: {
    shortLabel: "Spec",
    statusText: "Refining spatial specification",
    progress: 20,
  },
  turnaround: {
    shortLabel: "Sheet",
    statusText: "Synthesizing orthographic sheet",
    progress: 45,
  },
  slicing: {
    shortLabel: "Views",
    statusText: "Isolating four views",
    progress: 72,
  },
  reconstructing: {
    shortLabel: "Mesh",
    statusText: "Reconstructing watertight mesh",
    progress: 92,
  },
  complete: {
    shortLabel: "3D",
    statusText: "80 mm watertight solid",
    progress: 100,
  },
};

const PROMPT_SUGGESTIONS = [
  "Generate a cute robot",
  "Minimal ceramic desk planter",
  "Tactile anodized rotary knob",
];

export function App() {
  const prefersReducedMotion = useReducedMotion();
  const [isDark, setIsDark] = useState(false);
  const [prompt, setPrompt] = useState("Generate a cute robot");
  const [stage, setStage] = useState<PipelineStage>("idle");
  const [isAutoPlaying, setIsAutoPlaying] = useState(false);
  const [backendConnected, setBackendConnected] = useState(false);
  const [isStreamingBackend, setIsStreamingBackend] = useState(false);
  const [statusOverride, setStatusOverride] = useState<string | null>(null);
  const [progressOverride, setProgressOverride] = useState<number | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Project Management State
  const [projects, setProjects] = useState<ProjectItem[]>([]);
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
  const [isViewOnly, setIsViewOnly] = useState<boolean>(false);
  const [isProjectsDrawerOpen, setIsProjectsDrawerOpen] = useState<boolean>(false);
  const [isRenaming, setIsRenaming] = useState<boolean>(false);
  const [renameInput, setRenameInput] = useState<string>("");

  // System & Model Status State
  const [systemStatus, setSystemStatus] = useState<SystemStatus | null>(null);
  const [showModelDownloadModal, setShowModelDownloadModal] = useState<boolean>(false);
  const [isDownloadingModel, setIsDownloadingModel] = useState<boolean>(false);
  const [downloadProgress, setDownloadProgress] = useState<DownloadProgress | null>(null);
  const [showAgyModal, setShowAgyModal] = useState<boolean>(false);
  const [customAgyInput, setCustomAgyInput] = useState<string>("");

  // Remote Colab GPU Worker State
  const [showColabModal, setShowColabModal] = useState<boolean>(false);
  const [colabUrlInput, setColabUrlInput] = useState<string>("");
  const [colabStatus, setColabStatus] = useState<ColabWorkerStatus | null>(null);
  const [isProbingColab, setIsProbingColab] = useState<boolean>(false);

  const [asset, setAsset] = useState<AssetPayload>(DEFAULT_ROBOT_ASSET);
  const [meshInspectMode, setMeshInspectMode] = useState<"views" | "clay">(
    "views"
  );

  const [activeTile, setActiveTile] = useState<
    Exclude<CameraAngle, "orbit"> | null
  >(null);
  const [shading, setShading] = useState<ShadingMode>("studio");
  const [cameraAngle, setCameraAngle] = useState<CameraAngle>("orbit");
  const [exportFormat, setExportFormat] = useState<"stl" | "glb">("stl");

  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    setIsDark(media.matches);
    const listener = (e: MediaQueryListEvent) => setIsDark(e.matches);
    media.addEventListener("change", listener);
    return () => media.removeEventListener("change", listener);
  }, []);

  useEffect(() => {
    const root = document.documentElement;
    if (isDark) {
      root.classList.add("dark");
    } else {
      root.classList.remove("dark");
    }
  }, [isDark]);

  const refreshProjects = async () => {
    try {
      const res = await fetch(apiUrl("/api/projects"));
      if (res.ok) {
        const data = (await res.json()) as { projects?: ProjectItem[] };
        const projs = data.projects || [];
        setProjects(projs);
        return projs;
      }
    } catch {
      // Backend not connected
    }
    return [];
  };

  const openProject = async (projId: string, markViewOnly = true) => {
    try {
      const res = await fetch(apiUrl(`/api/projects/${projId}`));
      if (res.ok) {
        const data = await res.json();
        setActiveProjectId(projId);
        if (data.asset) {
          setAsset(data.asset);
        }
        if (data.project?.prompt) {
          setPrompt(data.project.prompt);
        }
        setStage(data.asset?.stage || "complete");
        setIsProjectsDrawerOpen(false);

        if (data.project?.is_processing) {
          setIsViewOnly(false);
          startGeneration(data.project.prompt, "live", projId);
        } else {
          setIsViewOnly(markViewOnly);
        }
      }
    } catch (err) {
      console.error("Failed to load project:", err);
    }
  };

  const handleRenameProject = async (projId: string, newName: string) => {
    if (!newName.trim()) return;
    try {
      const res = await fetch(apiUrl(`/api/projects/${projId}/rename`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: newName.trim() }),
      });
      if (res.ok) {
        setProjects((prev) =>
          prev.map((p) => (p.id === projId ? { ...p, name: newName.trim() } : p))
        );
        if (activeProjectId === projId) {
          setAsset((prev) => ({
            ...prev,
            project_name: newName.trim(),
            asset_name: newName.trim(),
          }));
        }
      }
    } catch (err) {
      console.error("Failed to rename project:", err);
    } finally {
      setIsRenaming(false);
    }
  };

  const handleDeleteProject = async (projId: string) => {
    if (!confirm(`Are you sure you want to delete ${projId}?`)) return;
    try {
      const res = await fetch(apiUrl(`/api/projects/${projId}`), { method: "DELETE" });
      if (res.ok) {
        setProjects((prev) => prev.filter((p) => p.id !== projId));
        if (activeProjectId === projId) {
          handleStartNewProject();
        }
      }
    } catch (err) {
      console.error("Failed to delete project:", err);
    }
  };

  const handleStartNewProject = () => {
    stopActiveStream();
    setActiveProjectId(null);
    setIsViewOnly(false);
    setStage("idle");
    setPrompt("");
    setIsProjectsDrawerOpen(false);
  };

  const startModelDownload = async () => {
    setIsDownloadingModel(true);
    setDownloadProgress({
      status: "starting",
      message: "Initializing checkpoint download...",
      progress: 0,
      file: "",
      downloaded_mb: 0,
      total_mb: 6250,
    });
    try {
      const res = await fetch(apiUrl("/api/system/models/download"), { method: "POST" });
      if (!res.ok || !res.body) {
        throw new Error("Download endpoint failed");
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const frames = buffer.split("\n\n");
        buffer = frames.pop() ?? "";

        for (const frame of frames) {
          const lines = frame.split("\n");
          let dataLine = "";
          for (const line of lines) {
            if (line.startsWith("data:")) {
              dataLine += line.slice(5).trim();
            }
          }
          if (!dataLine) continue;
          const ev = JSON.parse(dataLine) as DownloadProgress;
          setDownloadProgress(ev);
          if (ev.status === "complete") {
            setIsDownloadingModel(false);
            const sysRes = await fetch(apiUrl("/api/system/status"));
            if (sysRes.ok) {
              setSystemStatus(await sysRes.json());
            }
            setTimeout(() => setShowModelDownloadModal(false), 1400);
          }
        }
      }
    } catch (err) {
      setDownloadProgress({
        status: "error",
        message: String(err),
        progress: 0,
        file: "",
        downloaded_mb: 0,
        total_mb: 6250,
      });
      setIsDownloadingModel(false);
    }
  };

  const saveCustomAgyPath = async () => {
    if (!customAgyInput.trim()) return;
    try {
      const res = await fetch(apiUrl("/api/system/set-agy-path"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: customAgyInput.trim() }),
      });
      if (res.ok) {
        const sysRes = await fetch(apiUrl("/api/system/status"));
        if (sysRes.ok) {
          setSystemStatus(await sysRes.json());
        }
        setShowAgyModal(false);
      }
    } catch (err) {
      console.error("Failed to save agy path:", err);
    }
  };

  const probeColabWorker = async (urlToProbe: string, save = true) => {
    const cleanUrl = urlToProbe.trim();
    if (!cleanUrl) return;
    setIsProbingColab(true);
    try {
      const res = await fetch(apiUrl("/api/system/colab/probe"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: cleanUrl, save }),
      });
      if (res.ok) {
        const data = (await res.json()) as ColabWorkerStatus;
        setColabStatus(data);
        if (data.url) {
          setColabUrlInput(data.url);
        }
        if (save && data.ok) {
          setSystemStatus((prev) =>
            prev ? { ...prev, colab_url: data.url } : prev
          );
        }
      }
    } catch (err) {
      setColabStatus({
        ok: false,
        configured: true,
        url: cleanUrl,
        error: String(err),
      });
    } finally {
      setIsProbingColab(false);
    }
  };

  const disconnectColabWorker = async () => {
    setIsProbingColab(true);
    try {
      await fetch(apiUrl("/api/system/colab/probe"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: "", save: true }),
      });
      setColabStatus(null);
      setColabUrlInput("");
      setSystemStatus((prev) => (prev ? { ...prev, colab_url: null } : prev));
    } catch (err) {
      console.error("Failed to disconnect Colab worker:", err);
    } finally {
      setIsProbingColab(false);
    }
  };

  // Discover local FastAPI backend, existing projects, and system status on mount with retry polling
  useEffect(() => {
    let cancelled = false;
    let timer: number | null = null;

    async function probeBackend() {
      try {
        const [healthRes, projectsRes, systemRes] = await Promise.all([
          fetch(apiUrl("/api/health")),
          fetch(apiUrl("/api/projects")),
          fetch(apiUrl("/api/system/status")),
        ]);
        if (cancelled) return;
        if (healthRes.ok) {
          setBackendConnected(true);
        }
        if (systemRes.ok) {
          const sysData = (await systemRes.json()) as SystemStatus;
          setSystemStatus(sysData);
          if (sysData.colab_url) {
            setColabUrlInput(sysData.colab_url);
            probeColabWorker(sysData.colab_url, false);
          } else if (!sysData.models_ready) {
            setShowModelDownloadModal(true);
          }
        }
        if (projectsRes.ok) {
          const data = (await projectsRes.json()) as { projects?: ProjectItem[] };
          const projs = data.projects || [];
          setProjects(projs);
        }
      } catch {
        if (!cancelled) {
          setBackendConnected(false);
          timer = window.setTimeout(probeBackend, 1500);
        }
      }
    }

    probeBackend();
    return () => {
      cancelled = true;
      if (timer) window.clearTimeout(timer);
    };
  }, []);

  // Client-side progression fallback when playing in offline mode or manual play
  useEffect(() => {
    if (!isAutoPlaying || isStreamingBackend) return;

    const durations: Partial<Record<PipelineStage, number>> = {
      optimizing: 1900,
      turnaround: 2600,
      slicing: 3200,
      reconstructing: 2800,
    };

    const waitMs = durations[stage];
    if (!waitMs) {
      if (stage === "complete") {
        setIsAutoPlaying(false);
      }
      return;
    }

    const timer = window.setTimeout(() => {
      const idx = STAGE_ORDER.indexOf(stage);
      if (idx >= 0 && idx < STAGE_ORDER.length - 1) {
        const nextStage = STAGE_ORDER[idx + 1];
        setStage(nextStage);
        if (nextStage === "complete") {
          setIsAutoPlaying(false);
        }
      }
    }, waitMs);

    return () => window.clearTimeout(timer);
  }, [stage, isAutoPlaying, isStreamingBackend]);

  const stopActiveStream = () => {
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
    }
    setIsStreamingBackend(false);
    setStatusOverride(null);
    setProgressOverride(null);
  };

  const startGeneration = async (
    customPrompt?: string,
    overrideMode?: "auto" | "live" | "replay",
    targetProjectId?: string | null,
    fromStep: number = 1
  ) => {
    const nextPrompt =
      (customPrompt ?? prompt).trim() || "Generate a cute robot";
    setPrompt(nextPrompt);
    setErrorMessage(null);
    setActiveTile(null);
    setMeshInspectMode("views");
    setCameraAngle("orbit");
    stopActiveStream();

    const isReplay = overrideMode === "replay";
    const projIdToUse = targetProjectId !== undefined ? targetProjectId : (isReplay ? activeProjectId : null);

    // When starting a new generation (not an explicit replay or attached project):
    // 1. Clear active project ID so the backend allocates a fresh project_XXXX
    // 2. Clear view-only mode
    if (!isReplay && !targetProjectId) {
      setActiveProjectId(null);
      setIsViewOnly(false);
    } else if (targetProjectId) {
      setActiveProjectId(targetProjectId);
      setIsViewOnly(false);
    }

    if (!backendConnected) {
      setErrorMessage("Starting local pipeline backend... Please wait a few seconds and retry.");
      return;
    }

    const normalizedSlug =
      nextPrompt
        .toLowerCase()
        .replace(/^generate\s+(a\s+|an\s+)?/i, "")
        .replace(/[^a-z0-9]+/g, "_")
        .replace(/^_+|_+$/g, "") || "model_3d";

    if (!isReplay && !targetProjectId) {
      setAsset({
        asset_name: normalizedSlug,
        slug: normalizedSlug,
        project_name: nextPrompt.slice(0, 40),
        stage: "optimizing",
        completed_steps: [],
        urls: {
          sheet: null,
          glb: null,
          stl: null,
          mesh_preview: null,
        },
        tiles: [
          { id: "front", label: "Front", angle: "0°", src: "" },
          { id: "left", label: "Left", angle: "90°", src: "" },
          { id: "back", label: "Back", angle: "180°", src: "" },
          { id: "right", label: "Right", angle: "270°", src: "" },
        ],
        step1: {
          asset_name: normalizedSlug,
          character_design_spec: `Optimizing "${nextPrompt}" into a watertight 3D-printable character specification and 2x2 orthographic turnaround prompt...`,
        },
        step4: null,
        manifest: null,
      });
    }

    const controller = new AbortController();
    abortRef.current = controller;
    setIsStreamingBackend(true);
    setIsAutoPlaying(true);
    if (!targetProjectId) {
      setStage("optimizing");
    }

    try {
      const response = await fetch(apiUrl("/api/generate"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt: nextPrompt,
          mode: isReplay ? "replay" : "live",
          from_step: fromStep,
          to_step: 5,
          project_id: projIdToUse,
          remote_url: colabStatus?.ok && colabStatus.url ? colabStatus.url : undefined,
        }),
        signal: controller.signal,
      });

      if (!response.ok || !response.body) {
        throw new Error(`Pipeline request failed (${response.status})`);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const frames = buffer.split("\n\n");
        buffer = frames.pop() ?? "";

        for (const frame of frames) {
          const lines = frame.split("\n");
          let eventType = "message";
          let dataLine = "";
          for (const line of lines) {
            // Lines starting with ':' are SSE comments (e.g. ': keep-alive')
            if (line.startsWith(":")) {
              continue;
            }
            if (line.startsWith("event:")) {
              eventType = line.slice(6).trim();
            } else if (line.startsWith("data:")) {
              dataLine += line.slice(5).trim();
            }
          }
          if (!dataLine) continue;

          const payload = JSON.parse(dataLine) as {
            stage?: PipelineStage;
            message?: string;
            progress?: number;
            project_id?: string;
            asset?: AssetPayload;
          };

          if (payload.project_id && !activeProjectId) {
            setActiveProjectId(payload.project_id);
          }

          if (eventType === "error") {
            setErrorMessage(payload.message ?? "Pipeline execution failed.");
            setIsAutoPlaying(false);
            setIsStreamingBackend(false);
            setStage("idle");
            return;
          }

          if (payload.asset) {
            setAsset(payload.asset);
          }
          if (payload.stage) {
            setStage(payload.stage);
          }
          if (payload.message) {
            setStatusOverride(payload.message);
          }
          if (typeof payload.progress === "number") {
            setProgressOverride(payload.progress);
          }

          if (eventType === "complete") {
            setStage("complete");
            setIsAutoPlaying(false);
            setIsStreamingBackend(false);
            setStatusOverride(null);
            setProgressOverride(null);
            setIsViewOnly(true);
            refreshProjects();
          }
        }
      }
    } catch (err) {
      if ((err as Error).name === "AbortError") {
        return;
      }
      // Check if project is still running or completed in background
      const curProjId = projIdToUse || activeProjectId;
      if (curProjId) {
        try {
          const checkRes = await fetch(apiUrl(`/api/projects/${curProjId}`));
          if (checkRes.ok) {
            const checkData = await checkRes.json();
            if (checkData.asset) setAsset(checkData.asset);
            if (checkData.project?.stage === "complete") {
              setStage("complete");
              setIsViewOnly(true);
              setIsAutoPlaying(false);
              setIsStreamingBackend(false);
              return;
            }
          }
        } catch {
          // ignore
        }
      }
      setBackendConnected(false);
      setIsStreamingBackend(false);
      setIsAutoPlaying(true);
    }
  };

  const selectStageManually = (target: PipelineStage) => {
    stopActiveStream();
    setIsAutoPlaying(false);
    setErrorMessage(null);
    if (target !== "complete") {
      setCameraAngle("orbit");
    }
    setStage(target);
  };

  const resetToPrompt = () => {
    stopActiveStream();
    setIsAutoPlaying(false);
    setErrorMessage(null);
    setActiveTile(null);
    setCameraAngle("orbit");
    setActiveProjectId(null);
    setIsViewOnly(false);
    setPrompt("");
    setStage("idle");
  };

  const springTransition = prefersReducedMotion
    ? { duration: 0.01 }
    : { type: "spring" as const, stiffness: 260, damping: 28 };

  const isRunning =
    stage === "optimizing" ||
    stage === "turnaround" ||
    stage === "slicing" ||
    stage === "reconstructing";

  const activeTiles: OrthoTile[] = (
    asset.tiles && asset.tiles.some((t) => Boolean(t.src))
      ? asset.tiles
      : DEFAULT_ORTHO_TILES
  ).map((t) => ({ ...t, src: toBackendUrl(t.src) || t.src }));

  const sheetUrl = toBackendUrl(asset.urls.sheet);
  const glbUrl = toBackendUrl(asset.urls.glb) ?? "";
  const stlUrl = toBackendUrl(asset.urls.stl) ?? "";
  const meshPreviewUrl = toBackendUrl(asset.urls.mesh_preview);

  const heightMm = Math.round(
    asset.manifest?.target_height_mm ?? asset.step4?.target_height_mm ?? 80
  );
  const faceCount = asset.manifest?.mesh_stats?.faces;
  const faceCountFormatted = faceCount
    ? `${Math.round(faceCount / 1000)}k faces`
    : null;
  const octreeRes =
    asset.step4?.octree_resolution ?? asset.manifest?.octree_resolution ?? 320;
  const inferSteps = asset.step4?.num_inference_steps ?? 10;

  const currentStatusText = statusOverride ?? STAGE_META[stage].statusText;
  const currentProgress = progressOverride ?? STAGE_META[stage].progress;

  return (
    <div className="relative min-h-[100dvh] w-full overflow-hidden bg-[#f5f5f7] text-zinc-900 transition-colors duration-500 dark:bg-[#0b0b0e] dark:text-zinc-100 flex flex-col justify-between">
      {/* Subtle studio ambient radial illumination */}
      <div
        aria-hidden="true"
        className="pointer-events-none fixed inset-0 overflow-hidden"
      >
        <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 h-[680px] w-[680px] rounded-full bg-radial from-white/90 via-zinc-200/20 to-transparent blur-3xl dark:from-zinc-800/35 dark:via-zinc-900/10 dark:to-transparent" />
      </div>

      {/* Top Navigation Bar (Height <= 68px, single line) */}
      <header className="relative z-30 mx-auto flex h-[68px] w-full max-w-[1400px] items-center justify-between px-6">
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={handleStartNewProject}
            className="group flex items-center gap-2.5 text-left focus:outline-none"
          >
            <img
              src="/icon.png"
              alt="Form 3D"
              className="h-8 w-8 rounded-lg shadow-sm transition-transform duration-200 group-active:scale-95"
            />
            <span className="text-sm font-medium tracking-tight text-zinc-900 dark:text-zinc-100">
              Form 3D
            </span>
          </button>

          {/* Project Management: Switcher & Inline Rename (if existing projects) */}
          {projects.length > 0 && (
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setIsProjectsDrawerOpen(true)}
                className="liquid-glass-web-approx flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium text-zinc-800 transition-colors hover:text-zinc-950 dark:text-zinc-200 dark:hover:text-white"
                title="View projects list"
              >
                <FolderOpen size={14} className="text-[#0071e3]" />
                <span className="max-w-[130px] truncate">
                  {asset.project_name || activeProjectId || "Projects"}
                </span>
                <CaretDown size={10} className="text-zinc-400" />
              </button>

              {activeProjectId && (
                <div className="flex items-center gap-1">
                  {isRenaming ? (
                    <div className="flex items-center gap-1">
                      <input
                        type="text"
                        value={renameInput}
                        onChange={(e) => setRenameInput(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter")
                            handleRenameProject(activeProjectId, renameInput);
                          else if (e.key === "Escape") setIsRenaming(false);
                        }}
                        autoFocus
                        className="rounded-full border border-sky-500/50 bg-white/95 px-2.5 py-0.5 text-xs text-zinc-900 focus:outline-none dark:bg-zinc-800 dark:text-zinc-100"
                      />
                      <button
                        type="button"
                        onClick={() =>
                          handleRenameProject(activeProjectId, renameInput)
                        }
                        className="flex h-5 w-5 items-center justify-center rounded-full bg-emerald-500 text-white hover:bg-emerald-600"
                        title="Save name"
                      >
                        <Check size={11} weight="bold" />
                      </button>
                      <button
                        type="button"
                        onClick={() => setIsRenaming(false)}
                        className="flex h-5 w-5 items-center justify-center rounded-full bg-zinc-300 text-zinc-700 hover:bg-zinc-400 dark:bg-zinc-700 dark:text-zinc-300"
                        title="Cancel"
                      >
                        <X size={11} weight="bold" />
                      </button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={() => {
                        setRenameInput(asset.project_name || activeProjectId || "");
                        setIsRenaming(true);
                      }}
                      title="Rename project"
                      className="rounded-full p-1 text-zinc-400 transition-colors hover:text-zinc-700 dark:hover:text-zinc-200"
                    >
                      <PencilSimple size={13} />
                    </button>
                  )}

                  {isViewOnly && (
                    <span className="flex items-center gap-1 rounded-full bg-zinc-200/80 px-2 py-0.5 text-[11px] font-medium text-zinc-600 dark:bg-zinc-800/80 dark:text-zinc-300">
                      <Eye size={12} />
                      <span>View only</span>
                    </span>
                  )}
                </div>
              )}

              <button
                type="button"
                onClick={handleStartNewProject}
                title="Create new project from prompt"
                className="liquid-glass-web-approx flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-medium text-zinc-700 transition-colors hover:text-zinc-950 dark:text-zinc-300 dark:hover:text-white"
              >
                <Plus size={12} weight="bold" />
                <span>New</span>
              </button>
            </div>
          )}
        </div>

        {/* Interactive Stage Scrubber Pill (shown when project is open or running) */}
        {stage !== "idle" && (
          <nav
            aria-label="Pipeline states"
            className="liquid-glass-web-approx flex items-center gap-1 rounded-full p-1"
          >
            {STAGE_ORDER.map((item) => {
              const active = stage === item;
              const passed =
                STAGE_ORDER.indexOf(stage) > STAGE_ORDER.indexOf(item);
              return (
                <button
                  key={item}
                  type="button"
                  onClick={() => selectStageManually(item)}
                  className={`relative rounded-full px-3 py-1 text-xs font-medium transition-colors duration-200 focus:outline-none ${
                    active
                      ? "text-zinc-900 dark:text-zinc-100"
                      : passed
                        ? "text-zinc-600 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-200"
                        : "text-zinc-400 hover:text-zinc-700 dark:text-zinc-500 dark:hover:text-zinc-300"
                  }`}
                >
                  {active && (
                    <motion.span
                      layoutId="active-stage-pill"
                      transition={springTransition}
                      className="absolute inset-0 rounded-full bg-white shadow-xs dark:bg-zinc-800"
                    />
                  )}
                  <span className="relative z-10">
                    {STAGE_META[item].shortLabel}
                  </span>
                </button>
              );
            })}
          </nav>
        )}

        {/* Minimal Theme + Colab Remote GPU + Model Downloader Alert + Playback Controls */}
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setShowColabModal(true)}
            title={
              colabStatus?.ok
                ? `Connected to Colab GPU (${colabStatus.gpu_name || "CUDA"}) — ${colabStatus.url}`
                : colabStatus?.url
                  ? `Colab tunnel unreachable: ${colabStatus.error || colabStatus.url}`
                  : "Configure Google Colab Pro Remote GPU (A100/L4) via Cloudflare Tunnel"
            }
            className={`flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium transition-all active:scale-95 ${
              colabStatus?.ok
                ? "border border-emerald-500/40 bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"
                : colabStatus?.url
                  ? "border border-amber-500/40 bg-amber-500/15 text-amber-700 dark:text-amber-300"
                  : "liquid-glass-web-approx text-zinc-600 hover:text-zinc-900 dark:text-zinc-300 dark:hover:text-white"
            }`}
          >
            <span
              className={`h-2 w-2 rounded-full ${
                colabStatus?.ok
                  ? "bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.75)]"
                  : colabStatus?.url
                    ? "bg-amber-500"
                    : "bg-zinc-400 dark:bg-zinc-500"
              }`}
            />
            <span className="max-w-[140px] truncate">
              {colabStatus?.ok
                ? colabStatus.gpu_name?.replace("NVIDIA ", "") || "Colab GPU"
                : colabStatus?.url
                  ? "Colab Offline"
                  : "Colab GPU"}
            </span>
          </button>

          {systemStatus && !systemStatus.models_ready && !colabStatus?.ok && (
            <button
              type="button"
              onClick={() => setShowModelDownloadModal(true)}
              className="flex items-center gap-1.5 rounded-full border border-amber-500/40 bg-amber-500/15 px-3 py-1 text-xs font-medium text-amber-700 transition-transform active:scale-95 dark:text-amber-300"
            >
              <CloudArrowDown size={14} weight="bold" />
              <span>Download Models (~6GB)</span>
            </button>
          )}

          {systemStatus && !systemStatus.agy_installed && (
            <button
              type="button"
              onClick={() => setShowAgyModal(true)}
              className="flex items-center gap-1.5 rounded-full border border-rose-500/40 bg-rose-500/15 px-2.5 py-1 text-xs font-medium text-rose-700 transition-transform active:scale-95 dark:text-rose-300"
              title="Antigravity CLI configuration"
            >
              <WarningCircle size={14} weight="bold" />
              <span>agy CLI</span>
            </button>
          )}

          {stage !== "idle" && (
            <button
              type="button"
              onClick={() => {
                if (stage === "complete") {
                  startGeneration(prompt, "replay");
                } else if (isStreamingBackend) {
                  stopActiveStream();
                  setIsAutoPlaying(false);
                } else {
                  setIsAutoPlaying((prev) => !prev);
                }
              }}
              aria-label={
                stage === "complete"
                  ? "Replay flow"
                  : isAutoPlaying
                    ? "Pause progression"
                    : "Resume progression"
              }
              className="liquid-glass-web-approx flex h-8 w-8 items-center justify-center rounded-full text-zinc-600 transition-transform active:scale-95 hover:text-zinc-900 dark:text-zinc-300 dark:hover:text-white"
            >
              {stage === "complete" ? (
                <ArrowCounterClockwise size={14} weight="regular" />
              ) : isAutoPlaying ? (
                <Pause size={14} weight="fill" />
              ) : (
                <Play size={14} weight="fill" />
              )}
            </button>
          )}

          <button
            type="button"
            onClick={() => setIsDark((d) => !d)}
            aria-label="Toggle appearance"
            className="liquid-glass-web-approx flex h-8 w-8 items-center justify-center rounded-full text-zinc-600 transition-transform active:scale-95 hover:text-zinc-900 dark:text-zinc-300 dark:hover:text-white"
          >
            {isDark ? (
              <Sun size={15} weight="regular" />
            ) : (
              <Moon size={15} weight="regular" />
            )}
          </button>
        </div>
      </header>

      {/* Main Spatial Canvas */}
      <main className="relative z-10 flex flex-1 flex-col items-center justify-center px-6">
        <AnimatePresence mode="wait">
          {/* STAGE 0: IDLE PROMPT */}
          {stage === "idle" && (
            <motion.section
              key="stage-idle"
              initial={prefersReducedMotion ? false : { opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              exit={prefersReducedMotion ? undefined : { opacity: 0, y: -12 }}
              transition={springTransition}
              className="flex w-full max-w-xl flex-col items-center text-center"
            >
              <h1 className="mb-8 text-4xl font-medium tracking-tighter text-zinc-900 md:text-5xl dark:text-zinc-100">
                Object from thought.
              </h1>

              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  startGeneration();
                }}
                className="w-full"
              >
                <label htmlFor="object-prompt" className="sr-only">
                  Describe the 3D object to generate
                </label>
                <div className="liquid-glass-web-approx flex w-full items-center gap-3 rounded-full p-2 pl-6 transition-shadow duration-300 focus-within:ring-2 focus-within:ring-sky-500/40">
                  <input
                    id="object-prompt"
                    type="text"
                    value={prompt}
                    onChange={(e) => setPrompt(e.target.value)}
                    placeholder="Describe an object..."
                    className="w-full bg-transparent text-base text-zinc-900 placeholder:text-zinc-400 focus:outline-none dark:text-zinc-100 dark:placeholder:text-zinc-500"
                  />
                  <button
                    type="submit"
                    aria-label="Generate 3D model"
                    className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[#0071e3] text-white transition-transform duration-150 hover:bg-[#0077ed] active:scale-95"
                  >
                    <ArrowUp size={18} weight="bold" />
                  </button>
                </div>
              </form>

              {/* Whisper-quiet preset pills + execution mode switch */}
              <div className="mt-5 flex flex-wrap items-center justify-center gap-2">
                {PROMPT_SUGGESTIONS.map((item) => (
                  <button
                    key={item}
                    type="button"
                    onClick={() => startGeneration(item)}
                    className="rounded-full border border-zinc-200/80 bg-white/50 px-3.5 py-1.5 text-xs text-zinc-600 backdrop-blur-md transition-all hover:border-zinc-300 hover:bg-white hover:text-zinc-900 active:scale-98 dark:border-zinc-800 dark:bg-zinc-900/50 dark:text-zinc-400 dark:hover:border-zinc-700 dark:hover:text-zinc-200"
                  >
                    {item}
                  </button>
                ))}
              </div>

              {/* Requirement: if existing projects, show project list, and can open it (view only) */}
              {projects.length > 0 && (
                <div className="mt-8 w-full max-w-xl text-left">
                  <div className="flex items-center justify-between pb-2 mb-2 border-b border-zinc-200/60 dark:border-zinc-800">
                    <div className="flex items-center gap-2">
                      <FolderOpen size={15} className="text-[#0071e3]" />
                      <h2 className="text-xs font-semibold uppercase tracking-wider text-zinc-500 dark:text-zinc-400">
                        Existing Projects ({projects.length})
                      </h2>
                    </div>
                    <span className="text-[11px] text-zinc-400 dark:text-zinc-500">
                      Open in view only
                    </span>
                  </div>

                  <div className="space-y-2 max-h-[260px] overflow-y-auto pr-1">
                    {projects.map((p) => (
                      <div
                        key={p.id}
                        onClick={() => openProject(p.id, true)}
                        className="group flex items-center justify-between rounded-2xl border border-zinc-200/70 bg-white/70 p-3 shadow-2xs backdrop-blur-md transition-all hover:border-zinc-300 hover:bg-white hover:shadow-xs dark:border-zinc-800/80 dark:bg-zinc-900/60 dark:hover:border-zinc-700 dark:hover:bg-zinc-900 cursor-pointer"
                      >
                        <div className="flex items-center gap-3 min-w-0 flex-1">
                          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300 overflow-hidden border border-zinc-200/50 dark:border-zinc-700/50">
                            {p.preview_url ? (
                              <img
                                src={toBackendUrl(p.preview_url) || p.preview_url}
                                alt={p.name}
                                className="h-full w-full object-cover"
                              />
                            ) : (
                              <Cube size={18} />
                            )}
                          </div>
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2">
                              <span className="font-medium text-sm text-zinc-900 dark:text-zinc-100 truncate group-hover:text-[#0071e3] transition-colors">
                                {p.name}
                              </span>
                              <span className="font-mono text-[10px] text-zinc-400 dark:text-zinc-500 uppercase">
                                {p.id}
                              </span>
                            </div>
                            <p className="text-xs text-zinc-500 dark:text-zinc-400 truncate mt-0.5">
                              {p.prompt}
                            </p>
                          </div>
                        </div>

                        <div className="flex items-center gap-2 pl-3 shrink-0">
                          <span className="flex items-center gap-1 rounded-full bg-zinc-100/90 px-2.5 py-1 text-xs font-medium text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300 group-hover:bg-[#0071e3] group-hover:text-white transition-colors">
                            <Eye size={12} />
                            <span>View</span>
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {errorMessage && (
                <div
                  role="alert"
                  className="mt-4 flex items-center gap-2 rounded-2xl border border-red-200/80 bg-red-50/80 px-4 py-2.5 text-xs text-red-700 dark:border-red-900/50 dark:bg-red-950/40 dark:text-red-300"
                >
                  <WarningCircle size={15} weight="bold" className="shrink-0" />
                  <span className="line-clamp-2 text-left">{errorMessage}</span>
                </div>
              )}
            </motion.section>
          )}

          {/* STAGE 1: OPTIMIZING SPEC (Step 1: step1_prompt.json) */}
          {stage === "optimizing" && (
            <motion.section
              key="stage-optimizing"
              initial={
                prefersReducedMotion ? false : { opacity: 0, scale: 0.96 }
              }
              animate={{ opacity: 1, scale: 1 }}
              exit={
                prefersReducedMotion ? undefined : { opacity: 0, scale: 0.98 }
              }
              transition={springTransition}
              className="flex w-full max-w-lg flex-col items-center justify-center"
            >
              <div className="liquid-glass-web-approx flex w-full flex-col items-center rounded-[28px] p-7 text-center">
                <div className="relative mb-5 flex h-24 w-24 items-center justify-center">
                  <motion.div
                    animate={
                      prefersReducedMotion
                        ? undefined
                        : {
                            scale: [0.92, 1.06, 0.92],
                            opacity: [0.45, 0.85, 0.45],
                          }
                    }
                    transition={{
                      duration: 2.4,
                      repeat: Infinity,
                      ease: "easeInOut",
                    }}
                    className="h-20 w-20 rounded-full border border-sky-500/30 bg-sky-500/5"
                  />
                  <Sparkle
                    size={24}
                    weight="light"
                    className="absolute text-[#0071e3] dark:text-sky-400"
                  />
                </div>

                <div className="mb-3 flex flex-wrap items-center justify-center gap-2">
                  <span className="rounded-full bg-zinc-200/70 px-2.5 py-0.5 font-mono text-[11px] text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">
                    {asset.asset_name}
                  </span>
                  <span className="rounded-full bg-zinc-200/70 px-2.5 py-0.5 font-mono text-[11px] text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400">
                    {heightMm} mm Z-up
                  </span>
                  <span className="rounded-full bg-zinc-200/70 px-2.5 py-0.5 font-mono text-[11px] text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400">
                    2x2 orthographic
                  </span>
                </div>

                {asset.step1?.character_design_spec && (
                  <p className="line-clamp-3 max-w-[54ch] text-xs leading-relaxed text-zinc-600 dark:text-zinc-400">
                    {asset.step1.character_design_spec}
                  </p>
                )}
              </div>
            </motion.section>
          )}

          {/* STAGE 2: 2X2 TURNAROUND SHEET (Step 2: sheet.png) */}
          {stage === "turnaround" && (
            <motion.section
              key="stage-turnaround"
              initial={
                prefersReducedMotion ? false : { opacity: 0, scale: 0.95 }
              }
              animate={{ opacity: 1, scale: 1 }}
              exit={
                prefersReducedMotion ? undefined : { opacity: 0, scale: 1.02 }
              }
              transition={springTransition}
              className="flex flex-col items-center"
            >
              <div className="liquid-glass-web-approx relative overflow-hidden rounded-[28px] p-4">
                <div className="relative flex h-[340px] w-[340px] items-center justify-center overflow-hidden rounded-[20px] bg-white sm:h-[400px] sm:w-[400px] dark:bg-zinc-900">
                  {sheetUrl ? (
                    <img
                      src={sheetUrl}
                      alt="Orthographic 2x2 turnaround reference sheet"
                      className="h-full w-full object-contain"
                    />
                  ) : (
                    <div className="grid h-full w-full grid-cols-2 grid-rows-2 gap-4 p-6">
                      {(["0°", "90°", "180°", "270°"] as const).map((deg) => (
                        <div
                          key={deg}
                          className="flex flex-col items-center justify-center rounded-2xl bg-zinc-100/80 animate-pulse dark:bg-zinc-800/60"
                        >
                          <span className="font-mono text-[11px] text-zinc-400 dark:text-zinc-500">
                            {deg}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                  {/* Subtle optical quadrant crop hairlines */}
                  <div className="pointer-events-none absolute inset-0">
                    <div className="absolute left-1/2 top-3 bottom-3 w-px -translate-x-1/2 bg-sky-500/35" />
                    <div className="absolute top-1/2 left-3 right-3 h-px -translate-y-1/2 bg-sky-500/35" />
                  </div>
                </div>
              </div>
            </motion.section>
          )}

          {/* STAGE 3 & 4: 4 SLICED ORTHOGRAPHIC VIEWS (RGBA CUTOUT STUDIO PLATES + CLAY PREVIEW) */}
          {(stage === "slicing" || stage === "reconstructing") && (
            <motion.section
              key="stage-views"
              initial={prefersReducedMotion ? false : { opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={
                prefersReducedMotion ? undefined : { opacity: 0, scale: 0.96 }
              }
              transition={springTransition}
              className="flex w-full max-w-5xl flex-col items-center gap-4"
            >
              {stage === "reconstructing" && (
                <div className="flex items-center gap-2">
                  <div className="liquid-glass-web-approx hidden items-center gap-3 rounded-full px-3.5 py-1 font-mono text-[11px] text-zinc-600 sm:flex dark:text-zinc-400">
                    <span>{octreeRes} octree</span>
                    <span>{inferSteps} steps</span>
                    <span>{heightMm} mm</span>
                  </div>

                  {meshPreviewUrl && (
                    <div
                      role="group"
                      aria-label="Reconstruction view mode"
                      className="liquid-glass-web-approx flex items-center rounded-full p-0.5 text-xs"
                    >
                      <button
                        type="button"
                        onClick={() => setMeshInspectMode("views")}
                        className={`rounded-full px-3 py-1 font-medium transition-colors ${
                          meshInspectMode === "views"
                            ? "bg-white text-zinc-900 shadow-2xs dark:bg-zinc-800 dark:text-zinc-100"
                            : "text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-200"
                        }`}
                      >
                        Views
                      </button>
                      <button
                        type="button"
                        onClick={() => setMeshInspectMode("clay")}
                        className={`rounded-full px-3 py-1 font-medium transition-colors ${
                          meshInspectMode === "clay"
                            ? "bg-white text-zinc-900 shadow-2xs dark:bg-zinc-800 dark:text-zinc-100"
                            : "text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-200"
                        }`}
                      >
                        Clay Mesh
                      </button>
                    </div>
                  )}
                </div>
              )}

              {stage === "reconstructing" &&
              meshInspectMode === "clay" &&
              meshPreviewUrl ? (
                <div className="liquid-glass-web-approx relative overflow-hidden rounded-[28px] p-4">
                  <div className="relative h-[340px] w-[340px] overflow-hidden rounded-[20px] bg-white sm:h-[400px] sm:w-[400px]">
                    <img
                      src={meshPreviewUrl}
                      alt="2x2 clay-shaded orthographic mesh preview"
                      className="h-full w-full object-contain"
                    />
                  </div>
                </div>
              ) : (
                <div className="grid w-full grid-cols-2 gap-4 md:grid-cols-4 md:gap-5">
                  {activeTiles.map((tile, index) => {
                    const isSelected = activeTile === tile.id;
                    return (
                      <motion.button
                        key={tile.id}
                        layoutId={`tile-card-${tile.id}`}
                        type="button"
                        onClick={() =>
                          setActiveTile(isSelected ? null : tile.id)
                        }
                        initial={
                          prefersReducedMotion
                            ? false
                            : { opacity: 0, y: 18, scale: 0.92 }
                        }
                        animate={{
                          opacity: 1,
                          y: isSelected ? -6 : 0,
                          scale: isSelected ? 1.03 : 1,
                        }}
                        transition={{
                          ...springTransition,
                          delay: prefersReducedMotion ? 0 : index * 0.05,
                        }}
                        className={`liquid-glass-web-approx group relative flex aspect-square flex-col items-center justify-center overflow-hidden rounded-[28px] p-5 text-left transition-shadow focus:outline-none ${
                          isSelected
                            ? "ring-2 ring-[#0071e3]"
                            : "hover:border-zinc-300 dark:hover:border-zinc-700"
                        }`}
                      >
                        {/* Soft studio radial spotlight behind transparent RGBA cutout */}
                        <div
                          aria-hidden="true"
                          className="pointer-events-none absolute inset-6 rounded-full bg-radial from-white/95 via-zinc-100/40 to-transparent dark:from-zinc-700/35 dark:via-zinc-800/10 dark:to-transparent"
                        />

                        {/* Subtle optical scan line during Step 4/5 mesh synthesis */}
                        {stage === "reconstructing" &&
                          !prefersReducedMotion && (
                            <motion.div
                              aria-hidden="true"
                              animate={{ top: ["8%", "88%", "8%"] }}
                              transition={{
                                duration: 2.2,
                                repeat: Infinity,
                                ease: "easeInOut",
                              }}
                              className="pointer-events-none absolute left-4 right-4 z-20 h-[1.5px] bg-gradient-to-r from-transparent via-sky-500/70 to-transparent"
                            />
                          )}

                        {tile.src ? (
                          <img
                            src={tile.src}
                            alt={`${tile.label} orthographic cutout`}
                            className="relative z-10 h-full w-full object-contain drop-shadow-[0_14px_24px_rgba(0,0,0,0.12)] transition-transform duration-300 group-hover:scale-[1.04]"
                          />
                        ) : (
                          <div className="relative z-10 flex h-full w-full items-center justify-center">
                            <div className="h-24 w-24 rounded-full bg-zinc-200/70 animate-pulse dark:bg-zinc-800/70" />
                          </div>
                        )}

                        <div className="relative z-10 mt-2 flex w-full items-center justify-between px-1">
                          <span className="text-xs font-medium text-zinc-700 dark:text-zinc-300">
                            {tile.label}
                          </span>
                          <span className="font-mono text-[11px] text-zinc-400 dark:text-zinc-500">
                            {tile.angle}
                          </span>
                        </div>
                      </motion.button>
                    );
                  })}
                </div>
              )}
            </motion.section>
          )}

          {/* STAGE 5: FULL 3D MODEL STAGE + DOCKED 2D ORTHOGRAPHIC THUMBNAILS */}
          {stage === "complete" && (
            <motion.section
              key="stage-complete"
              initial={prefersReducedMotion ? false : { opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={prefersReducedMotion ? undefined : { opacity: 0 }}
              transition={springTransition}
              className="relative flex h-[calc(100dvh-148px)] w-full max-w-[1400px] items-center justify-center"
            >
              {/* Full Interactive 3D WebGL Turntable Stage */}
              <div className="absolute inset-0">
                <Suspense
                  fallback={
                    <div className="flex h-full w-full items-center justify-center">
                      <div className="h-24 w-24 animate-pulse rounded-full border border-zinc-300/60 dark:border-zinc-700/60" />
                    </div>
                  }
                >
                  <Viewport3D
                    glbUrl={glbUrl}
                    shading={shading}
                    cameraAngle={cameraAngle}
                    isDark={isDark}
                    autoRotate={cameraAngle === "orbit"}
                  />
                </Suspense>
              </div>

              {/* Left Floating Glass Dock: 4 Sliced 2D Views synced to 3D Camera */}
              <aside
                aria-label="Orthographic reference views"
                className="liquid-glass-web-approx absolute left-0 top-1/2 z-20 hidden -translate-y-1/2 flex-col gap-2 rounded-[24px] p-2 sm:flex"
              >
                {activeTiles.map((tile) => {
                  const selected = cameraAngle === tile.id;
                  return (
                    <motion.button
                      key={tile.id}
                      layoutId={`tile-card-${tile.id}`}
                      type="button"
                      onClick={() =>
                        setCameraAngle(selected ? "orbit" : tile.id)
                      }
                      title={`${tile.label} view (${tile.angle})`}
                      className={`group relative flex h-14 w-14 flex-col items-center justify-center overflow-hidden rounded-[16px] p-1.5 transition-all focus:outline-none ${
                        selected
                          ? "bg-white shadow-xs ring-2 ring-[#0071e3] dark:bg-zinc-800"
                          : "hover:bg-white/60 dark:hover:bg-zinc-800/50"
                      }`}
                    >
                      <img
                        src={tile.src}
                        alt={tile.label}
                        className="h-full w-full object-contain"
                      />
                      <span className="sr-only">{tile.label}</span>
                    </motion.button>
                  );
                })}
              </aside>

              {/* Optional 2D Reference Card Overlay when locked to an orthographic angle */}
              <AnimatePresence>
                {cameraAngle !== "orbit" && (
                  <motion.div
                    initial={
                      prefersReducedMotion
                        ? false
                        : { opacity: 0, x: 12, scale: 0.96 }
                    }
                    animate={{ opacity: 1, x: 0, scale: 1 }}
                    exit={
                      prefersReducedMotion
                        ? undefined
                        : { opacity: 0, x: 12, scale: 0.96 }
                    }
                    transition={springTransition}
                    className="liquid-glass-web-approx absolute right-0 top-1/2 z-20 hidden -translate-y-1/2 flex-col items-center rounded-[24px] p-3 sm:flex"
                  >
                    <img
                      src={
                        activeTiles.find((t) => t.id === cameraAngle)?.src ??
                        activeTiles[0].src
                      }
                      alt="2D reference cutout"
                      className="h-36 w-36 object-contain"
                    />
                    <div className="mt-1 flex w-full items-center justify-between px-1 text-[11px] text-zinc-500 dark:text-zinc-400">
                      <span className="capitalize">{cameraAngle} 2D</span>
                      <button
                        type="button"
                        onClick={() => setCameraAngle("orbit")}
                        className="font-medium text-[#0071e3] hover:underline"
                      >
                        Free orbit
                      </button>
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </motion.section>
          )}
        </AnimatePresence>
      </main>

      {/* Bottom Dock: Minimal Progress Bar (while running) OR 3D Studio Controls (when complete) */}
      <footer className="relative z-30 mx-auto flex h-[80px] w-full max-w-[1400px] items-center justify-center px-6 pb-4">
        <AnimatePresence mode="wait">
          {isRunning && (
            <motion.div
              key="dock-progress"
              initial={prefersReducedMotion ? false : { opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              exit={prefersReducedMotion ? undefined : { opacity: 0, y: 12 }}
              transition={springTransition}
              className="liquid-glass-web-approx flex w-full max-w-md flex-col gap-2 rounded-full px-5 py-3"
            >
              <div className="flex items-center justify-between text-xs">
                <span className="font-medium text-zinc-800 dark:text-zinc-200">
                  {currentStatusText}
                </span>
                <span className="font-mono text-zinc-400 dark:text-zinc-500">
                  {currentProgress}%
                </span>
              </div>
              <div className="h-[3px] w-full overflow-hidden rounded-full bg-zinc-200/80 dark:bg-zinc-800">
                <motion.div
                  className="h-full rounded-full bg-[#0071e3]"
                  initial={{ width: "0%" }}
                  animate={{ width: `${currentProgress}%` }}
                  transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
                />
              </div>
            </motion.div>
          )}

          {stage === "complete" && (
            <motion.div
              key="dock-complete"
              initial={prefersReducedMotion ? false : { opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              exit={prefersReducedMotion ? undefined : { opacity: 0, y: 12 }}
              transition={springTransition}
              className="liquid-glass-web-approx flex items-center gap-3 rounded-full p-1.5 pl-4"
            >
              {/* Watertight 80mm status */}
              <div
                className="hidden items-center gap-1.5 pr-2 text-xs text-zinc-600 sm:flex dark:text-zinc-300"
                title={
                  faceCountFormatted
                    ? `Watertight solid (${faceCountFormatted})`
                    : "Watertight solid"
                }
              >
                <Check
                  size={14}
                  weight="bold"
                  className="text-emerald-600 dark:text-emerald-400"
                />
                <span>{heightMm} mm</span>
                {faceCountFormatted && (
                  <span className="hidden font-mono text-[11px] text-zinc-400 md:inline dark:text-zinc-500">
                    {faceCountFormatted}
                  </span>
                )}
              </div>

              {/* Shading Segmented Pill */}
              <div
                role="group"
                aria-label="Surface shading"
                className="flex items-center rounded-full bg-zinc-200/60 p-0.5 dark:bg-zinc-800/80"
              >
                {(["studio", "clay", "wire"] as ShadingMode[]).map((mode) => (
                  <button
                    key={mode}
                    type="button"
                    onClick={() => setShading(mode)}
                    className={`rounded-full px-3 py-1 text-xs font-medium capitalize transition-colors ${
                      shading === mode
                        ? "bg-white text-zinc-900 shadow-2xs dark:bg-zinc-900 dark:text-zinc-100"
                        : "text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-200"
                    }`}
                  >
                    {mode}
                  </button>
                ))}
              </div>

              {/* Format Switch (.STL / .GLB) */}
              <button
                type="button"
                onClick={() =>
                  setExportFormat((f) => (f === "stl" ? "glb" : "stl"))
                }
                className="rounded-full px-2.5 py-1 font-mono text-xs uppercase text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-200"
                title="Switch export format"
              >
                .{exportFormat}
              </button>

              {/* Single Primary CTA */}
              <a
                href={exportFormat === "stl" ? stlUrl : glbUrl}
                download={`${asset.slug}.${exportFormat}`}
                className="flex items-center gap-1.5 rounded-full bg-[#0071e3] px-4 py-2 text-xs font-medium text-white transition-transform duration-150 hover:bg-[#0077ed] active:scale-95"
              >
                <DownloadSimple size={14} weight="bold" />
                <span>Export</span>
              </a>

              {/* New Prompt icon button */}
              <button
                type="button"
                onClick={resetToPrompt}
                aria-label="New prompt"
                title="New prompt"
                className="flex h-8 w-8 items-center justify-center rounded-full text-zinc-500 transition-colors hover:bg-zinc-200/60 hover:text-zinc-900 active:scale-95 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
              >
                <Plus size={15} weight="bold" />
              </button>
            </motion.div>
          )}
        </AnimatePresence>
      </footer>

      {/* Project List Drawer / Modal */}
      <AnimatePresence>
        {isProjectsDrawerOpen && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setIsProjectsDrawerOpen(false)}
              className="absolute inset-0 bg-black/40 backdrop-blur-sm"
            />
            <motion.div
              initial={{ opacity: 0, scale: 0.95, y: 10 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 10 }}
              transition={springTransition}
              className="relative z-10 flex max-h-[85vh] w-full max-w-2xl flex-col rounded-3xl border border-white/60 bg-white/95 p-6 shadow-2xl backdrop-blur-2xl dark:border-white/10 dark:bg-zinc-900/95"
            >
              <div className="flex items-center justify-between pb-4 border-b border-zinc-200/60 dark:border-zinc-800">
                <div className="flex items-center gap-2">
                  <FolderOpen size={20} className="text-[#0071e3]" />
                  <h2 className="text-base font-semibold text-zinc-900 dark:text-zinc-100">
                    Projects ({projects.length})
                  </h2>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={handleStartNewProject}
                    className="flex items-center gap-1.5 rounded-full bg-[#0071e3] px-3 py-1 text-xs font-medium text-white hover:bg-[#0077ed]"
                  >
                    <Plus size={12} weight="bold" />
                    <span>New Project</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => setIsProjectsDrawerOpen(false)}
                    className="flex h-7 w-7 items-center justify-center rounded-full text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800"
                  >
                    <X size={15} />
                  </button>
                </div>
              </div>

              <div className="mt-4 flex-1 overflow-y-auto space-y-2 pr-1">
                {projects.map((p) => {
                  const isCurrent = activeProjectId === p.id;
                  return (
                    <div
                      key={p.id}
                      className={`group flex items-center justify-between rounded-2xl p-3.5 transition-all ${
                        isCurrent
                          ? "bg-sky-500/10 border border-sky-500/30"
                          : "border border-zinc-200/60 hover:bg-zinc-100/70 dark:border-zinc-800/80 dark:hover:bg-zinc-800/50"
                      }`}
                    >
                      <button
                        type="button"
                        onClick={() => openProject(p.id, true)}
                        className="flex flex-1 items-start gap-3 text-left focus:outline-none"
                      >
                        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">
                          {p.preview_url ? (
                            <img
                              src={toBackendUrl(p.preview_url) || p.preview_url}
                              alt={p.name}
                              className="h-full w-full rounded-xl object-cover"
                            />
                          ) : (
                            <Cube size={20} />
                          )}
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="font-medium text-sm text-zinc-900 dark:text-zinc-100 truncate">
                              {p.name}
                            </span>
                            <span className="font-mono text-[10px] text-zinc-400 dark:text-zinc-500 uppercase">
                              {p.id}
                            </span>
                          </div>
                          <p className="text-xs text-zinc-500 dark:text-zinc-400 truncate mt-0.5">
                            {p.prompt}
                          </p>
                        </div>
                      </button>

                      <div className="flex items-center gap-2 pl-3">
                        <button
                          type="button"
                          onClick={() => openProject(p.id, true)}
                          className="flex items-center gap-1 rounded-full bg-zinc-200/80 px-2.5 py-1 text-xs font-medium text-zinc-700 hover:bg-zinc-300 dark:bg-zinc-800 dark:text-zinc-300 dark:hover:bg-zinc-700"
                        >
                          <Eye size={13} />
                          <span>View</span>
                        </button>
                        <button
                          type="button"
                          onClick={() => handleDeleteProject(p.id)}
                          className="rounded-full p-1.5 text-zinc-400 hover:text-rose-600 dark:hover:text-rose-400"
                          title="Delete project"
                        >
                          <TrashSimple size={15} />
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* Model Download Modal (First-time setup with progress bar) */}
      <AnimatePresence>
        {showModelDownloadModal && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => {
                if (!isDownloadingModel) setShowModelDownloadModal(false);
              }}
              className="absolute inset-0 bg-black/50 backdrop-blur-sm"
            />
            <motion.div
              initial={{ opacity: 0, scale: 0.95, y: 10 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 10 }}
              transition={springTransition}
              className="relative z-10 w-full max-w-lg rounded-3xl border border-white/60 bg-white/95 p-6 shadow-2xl backdrop-blur-2xl dark:border-white/10 dark:bg-zinc-900/95"
            >
              <div className="flex items-center justify-between pb-3">
                <div className="flex items-center gap-2.5">
                  <div className="flex h-9 w-9 items-center justify-center rounded-full bg-amber-500/15 text-amber-600 dark:text-amber-400">
                    <CloudArrowDown size={20} weight="bold" />
                  </div>
                  <div>
                    <h2 className="text-base font-semibold text-zinc-900 dark:text-zinc-100">
                      3D Neural Weights Setup
                    </h2>
                    <p className="text-xs text-zinc-500 dark:text-zinc-400">
                      Hunyuan3D-2mv DiT & Rembg Checkpoints (~6.2 GB)
                    </p>
                  </div>
                </div>
                {!isDownloadingModel && (
                  <button
                    type="button"
                    onClick={() => setShowModelDownloadModal(false)}
                    className="flex h-7 w-7 items-center justify-center rounded-full text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800"
                  >
                    <X size={15} />
                  </button>
                )}
              </div>

              <div className="mt-4 space-y-4">
                <p className="text-xs leading-relaxed text-zinc-600 dark:text-zinc-300">
                  Form 3D Studio reconstructs watertight, 3D-printable solid meshes locally on Apple Silicon Metal (MPS). Model checkpoints are downloaded once to standard macOS application support storage.
                </p>

                {/* Progress Bar View */}
                {downloadProgress && (
                  <div className="rounded-2xl border border-zinc-200/80 bg-zinc-50/80 p-4 dark:border-zinc-800 dark:bg-zinc-800/40">
                    <div className="flex items-center justify-between text-xs">
                      <span className="font-medium text-zinc-800 dark:text-zinc-200">
                        {downloadProgress.file || "Downloading..."}
                      </span>
                      <span className="font-mono text-zinc-500 dark:text-zinc-400">
                        {downloadProgress.progress}%
                      </span>
                    </div>

                    <div className="mt-2 h-2.5 w-full overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-700">
                      <motion.div
                        className="h-full rounded-full bg-[#0071e3]"
                        initial={{ width: "0%" }}
                        animate={{ width: `${downloadProgress.progress}%` }}
                        transition={{ duration: 0.3 }}
                      />
                    </div>

                    <div className="mt-2 flex items-center justify-between text-[11px] text-zinc-500 dark:text-zinc-400">
                      <span>{downloadProgress.message}</span>
                      <span className="font-mono">
                        {downloadProgress.downloaded_mb} / {downloadProgress.total_mb} MB
                      </span>
                    </div>
                  </div>
                )}

                <div className="flex items-center justify-end gap-2 pt-2">
                  {!isDownloadingModel && (
                    <button
                      type="button"
                      onClick={() => setShowModelDownloadModal(false)}
                      className="rounded-full px-4 py-2 text-xs font-medium text-zinc-600 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800"
                    >
                      Later
                    </button>
                  )}
                  <button
                    type="button"
                    disabled={isDownloadingModel}
                    onClick={startModelDownload}
                    className="flex items-center gap-2 rounded-full bg-[#0071e3] px-5 py-2 text-xs font-medium text-white hover:bg-[#0077ed] active:scale-95 disabled:opacity-50"
                  >
                    <CloudArrowDown size={14} weight="bold" />
                    <span>{isDownloadingModel ? "Downloading..." : "Download Models (~6.2 GB)"}</span>
                  </button>
                </div>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* agy CLI Configuration Modal */}
      <AnimatePresence>
        {showAgyModal && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setShowAgyModal(false)}
              className="absolute inset-0 bg-black/50 backdrop-blur-sm"
            />
            <motion.div
              initial={{ opacity: 0, scale: 0.95, y: 10 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 10 }}
              transition={springTransition}
              className="relative z-10 w-full max-w-md rounded-3xl border border-white/60 bg-white/95 p-6 shadow-2xl backdrop-blur-2xl dark:border-white/10 dark:bg-zinc-900/95"
            >
              <div className="flex items-center justify-between pb-3">
                <div className="flex items-center gap-2">
                  <Cube size={20} className="text-[#0071e3]" />
                  <h2 className="text-base font-semibold text-zinc-900 dark:text-zinc-100">
                    Antigravity CLI (agy)
                  </h2>
                </div>
                <button
                  type="button"
                  onClick={() => setShowAgyModal(false)}
                  className="flex h-7 w-7 items-center justify-center rounded-full text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800"
                >
                  <X size={15} />
                </button>
              </div>

              <p className="mt-2 text-xs leading-relaxed text-zinc-600 dark:text-zinc-300">
                Form 3D Studio relies on the local <code>agy</code> CLI for prompt engineering and orthographic turnaround generation.
              </p>

              <div className="mt-4 space-y-2">
                <label className="text-xs font-medium text-zinc-700 dark:text-zinc-300">
                  Custom Executable Path
                </label>
                <div className="flex items-center gap-2">
                  <input
                    type="text"
                    value={customAgyInput}
                    onChange={(e) => setCustomAgyInput(e.target.value)}
                    placeholder={systemStatus?.agy_path || "/opt/homebrew/bin/agy"}
                    className="w-full rounded-xl border border-zinc-300 bg-white px-3 py-2 text-xs text-zinc-900 focus:outline-none dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
                  />
                  <button
                    type="button"
                    onClick={saveCustomAgyPath}
                    className="shrink-0 rounded-xl bg-[#0071e3] px-3.5 py-2 text-xs font-medium text-white hover:bg-[#0077ed]"
                  >
                    Save
                  </button>
                </div>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* Google Colab Pro Remote GPU (Cloudflare Tunnel) Modal */}
      <AnimatePresence>
        {showColabModal && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setShowColabModal(false)}
              className="absolute inset-0 bg-black/50 backdrop-blur-sm"
            />
            <motion.div
              initial={{ opacity: 0, scale: 0.95, y: 10 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 10 }}
              transition={springTransition}
              className="relative z-10 w-full max-w-lg rounded-3xl border border-white/60 bg-white/95 p-6 shadow-2xl backdrop-blur-2xl dark:border-white/10 dark:bg-zinc-900/95"
            >
              <div className="flex items-center justify-between pb-3">
                <div className="flex items-center gap-2.5">
                  <div className="flex h-9 w-9 items-center justify-center rounded-full bg-sky-500/15 text-[#0071e3] dark:text-sky-400">
                    <Sparkle size={20} weight="fill" />
                  </div>
                  <div>
                    <h2 className="text-base font-semibold text-zinc-900 dark:text-zinc-100">
                      Google Colab Pro Remote GPU (Step 5)
                    </h2>
                    <p className="text-xs text-zinc-500 dark:text-zinc-400">
                      Hybrid Architecture · Local Steps 1–4 + Remote CUDA A100/L4 Mesh Synthesis
                    </p>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => setShowColabModal(false)}
                  className="flex h-7 w-7 items-center justify-center rounded-full text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800"
                >
                  <X size={15} />
                </button>
              </div>

              <p className="mt-2 text-xs leading-relaxed text-zinc-600 dark:text-zinc-300">
                Open <code>colab/colab_3d_worker.ipynb</code> in Google Colab Pro, run all cells, and paste the generated <code>https://*.trycloudflare.com</code> Quick Tunnel URL below.
              </p>

              <div className="mt-4 space-y-3">
                <label className="text-xs font-medium text-zinc-700 dark:text-zinc-300">
                  Cloudflare Quick Tunnel URL
                </label>
                <div className="flex items-center gap-2">
                  <input
                    type="text"
                    value={colabUrlInput}
                    onChange={(e) => setColabUrlInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && colabUrlInput.trim()) {
                        probeColabWorker(colabUrlInput, true);
                      }
                    }}
                    placeholder="https://xxxx-xxxx.trycloudflare.com"
                    className="w-full rounded-xl border border-zinc-300 bg-white px-3 py-2 font-mono text-xs text-zinc-900 focus:border-[#0071e3] focus:outline-none dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
                  />
                  <button
                    type="button"
                    disabled={isProbingColab || !colabUrlInput.trim()}
                    onClick={() => probeColabWorker(colabUrlInput, true)}
                    className="shrink-0 rounded-xl bg-[#0071e3] px-4 py-2 text-xs font-medium text-white hover:bg-[#0077ed] disabled:opacity-50"
                  >
                    {isProbingColab ? "Checking..." : "Connect"}
                  </button>
                </div>

                {/* Live Health Check Readout */}
                {colabStatus && (
                  <div
                    className={`rounded-2xl border p-3.5 text-xs ${
                      colabStatus.ok
                        ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-900 dark:text-emerald-200"
                        : "border-rose-500/30 bg-rose-500/10 text-rose-800 dark:text-rose-200"
                    }`}
                  >
                    {colabStatus.ok ? (
                      <div className="space-y-1.5">
                        <div className="flex items-center justify-between font-semibold">
                          <span className="flex items-center gap-1.5">
                            <Check size={14} weight="bold" className="text-emerald-600 dark:text-emerald-400" />
                            <span>Connected · {colabStatus.gpu_name}</span>
                          </span>
                          {typeof colabStatus.latency_ms === "number" && (
                            <span className="font-mono text-[11px] opacity-80">
                              {colabStatus.latency_ms} ms
                            </span>
                          )}
                        </div>
                        <div className="grid grid-cols-2 gap-1 pt-1 font-mono text-[11px] opacity-90">
                          <span>
                            VRAM: {colabStatus.vram_free_gb ?? "?"} GB free / {colabStatus.vram_total_gb ?? "?"} GB
                          </span>
                          <span>Model: {colabStatus.model_id || "Hunyuan3D-2mv"}</span>
                          <span>
                            Google Drive: {colabStatus.drive_mounted ? "Synced" : "Ephemeral"}
                          </span>
                          <span>Jobs completed: {colabStatus.jobs_completed ?? 0}</span>
                        </div>
                      </div>
                    ) : (
                      <div className="flex items-start gap-2">
                        <WarningCircle size={15} weight="bold" className="mt-0.5 shrink-0" />
                        <span>{colabStatus.error || "Unable to reach Colab worker."}</span>
                      </div>
                    )}
                  </div>
                )}

                <div className="flex items-center justify-between pt-2">
                  <span className="text-[11px] text-zinc-500 dark:text-zinc-400">
                    Active compute:{" "}
                    <strong className="text-zinc-800 dark:text-zinc-200">
                      {colabStatus?.ok
                        ? `Remote (${colabStatus.gpu_name})`
                        : `Local (${systemStatus?.device || "mps"})`}
                    </strong>
                  </span>
                  {colabStatus?.url && (
                    <button
                      type="button"
                      onClick={disconnectColabWorker}
                      className="rounded-full px-3 py-1.5 text-xs font-medium text-rose-600 hover:bg-rose-500/10 dark:text-rose-400"
                    >
                      Use Local MPS
                    </button>
                  )}
                </div>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </div>
  );
}
export default App;
