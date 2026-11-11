# Form 3D

> **5-Step Modular Text-to-3D Generator (`.stl` & `.glb`) for Apple Silicon and Cloud GPUs**

Form 3D is an open-source, modular Text-to-3D pipeline designed for creators, digital sculptors, and 3D-printing enthusiasts. It transforms natural language prompts into watertight, 3D-printable `.stl` meshes and textured `.glb` models using Tencent Hunyuan3D-2 multi-view reconstruction paired with intelligent prompt-and-view orchestration via the Antigravity CLI (`agy`).

---

## Highlights

- **5-Step Modular Pipeline:** Every stage (prompt expansion, turnaround sheet generation, background removal & quadrant slicing, camera alignment, and 3D reconstruction) is independently inspectable, reproducible, and verifiable.
- **Dual Inference Engine:**
  - **Local Apple Silicon (`mps`):** Runs natively on macOS Apple Silicon (M1/M2/M3/M4) with Metal Performance Shaders.
  - **Cloud GPU Offload (Google Colab Pro):** Easily offload heavy multi-view mesh synthesis to an NVIDIA A100/L4 GPU over a secure Cloudflare tunnel in ~7–12 seconds.
- **3D-Print Ready Post-Processing:**
  - Automated floating debris removal.
  - Taubin smoothing to preserve sharp contours without shrinking volume.
  - Canonical orientation: Y-up $\rightarrow$ Z-up coordinate transformation.
  - Base seating flat at $Z = 0$ and parametric scaling (default 80mm height).
- **Interactive Studio UI:** Modern Three.js WebGL studio featuring orbit navigation, ortho sync views, wireframe/clay shading modes, and real-time Server-Sent Events (SSE) progress tracking.
- **Desktop App Ready:** Packaged with Tauri v2 for native macOS performance.

---

## Architecture

```text
[ User Prompt ]
      │
      ▼
┌────────────────────────────────────────────────────────┐
│ Step 1: Optimize Prompt (agy CLI + JSON Schema)        │
│ Generates 3D character spec & 2x2 turnaround prompt    │
└──────────────────────────┬─────────────────────────────┘
                           │
                           ▼
┌────────────────────────────────────────────────────────┐
│ Step 2: Synthesize Turnaround Sheet (Image Subagent)   │
│ Produces a 1024x1024 2x2 orthographic sheet (PNG)      │
└──────────────────────────┬─────────────────────────────┘
                           │
                           ▼
┌────────────────────────────────────────────────────────┐
│ Step 3: Quadrant Slicer & Alpha Cleaner (rembg + CV2)  │
│ Crops 4 views (TL, TR, BL, BR), removes backgrounds    │
└──────────────────────────┬─────────────────────────────┘
                           │
                           ▼
┌────────────────────────────────────────────────────────┐
│ Step 4: 3D Camera & Orientation Verification           │
│ Maps quadrants to Front (0°), Left, Back, Right (270°) │
└──────────────────────────┬─────────────────────────────┘
                           │
                           ▼
┌────────────────────────────────────────────────────────┐
│ Step 5: Mesh Synthesis & 3D Print Preparation          │
│ Local MPS / Colab CUDA (Hunyuan3D-2mv)                 │
│ Output: Watertight .stl, .glb, and manifest.json       │
└────────────────────────────────────────────────────────┘
```

---

## Requirements

- **Operating System:** macOS (Apple Silicon M1/M2/M3/M4 with $\ge$ 16GB Unified Memory recommended for local inference) or Linux with NVIDIA CUDA $\ge$ 12.1.
- **Python:** 3.11 (`uv` package manager recommended).
- **Node.js:** 20+ and `npm` (for the WebGL Studio UI).
- **Antigravity CLI (`agy`):** Required for Step 1 prompt expansion and Step 2 turnaround synthesis. Ensure `agy` is available in your `$PATH` or configured via `.env`.

---

## Quick Start

### 1. Installation

Clone the repository and install dependencies using [`uv`](https://docs.astral.sh/uv/):

```bash
# Clone the repository
git clone https://github.com/layerzero-dev/form3d.git
cd form3d

# Install Python virtual environment and dependencies
uv sync

# Install Frontend dependencies
cd ui
npm install
cd ..
```

### 2. Run the Command-Line Pipeline

Generate a 3D model end-to-end from a single text prompt:

```bash
# Full 5-step pipeline execution
uv run python run_pipeline.py "Generate an armored cybernetic owl"

# Inspect generated files in outputs/
ls -lh outputs/armored_cybernetic_owl/
# Outputs:
#   armored_cybernetic_owl.stl
#   armored_cybernetic_owl.glb
#   armored_cybernetic_owl_mesh_preview.png
#   manifest.json
```

You can also resume or re-run specific steps:
```bash
# Re-run mesh reconstruction (Step 5) with a custom target height
uv run python run_pipeline.py "Generate a cute robot" --from-step 5
```

### 3. Launch the Studio UI

Start the FastAPI backend server:
```bash
uv run python server.py
```

In another terminal, start the Vite WebGL interface:
```bash
cd ui
npm run dev
```

Open your browser at `http://localhost:5173`.

---

## Google Colab Pro Hybrid Worker (Optional)

If running on a low-memory machine or when faster generation speeds are needed, you can offload Step 5 mesh generation to Google Colab Pro:

1. Open [`colab/colab_3d_worker.ipynb`](colab/colab_3d_worker.ipynb) in Google Colab with an A100 or L4 GPU runtime.
2. Run all cells in the notebook. This launches a Cloudflare Tunnel and displays your public tunnel URL:
   ```text
   Tunnel URL: https://your-tunnel-name.trycloudflare.com
   ```
3. Pass your tunnel URL when running the CLI:
   ```bash
   uv run python run_pipeline.py "A futuristic racer" --remote-url https://your-tunnel-name.trycloudflare.com
   ```
   Or set it in your environment:
   ```bash
   export COLAB_BACKEND_URL="https://your-tunnel-name.trycloudflare.com"
   ```
   In the Studio UI, simply paste the URL into the Colab settings panel in the top-right toolbar.

---

## Testing

Run the test suite to verify the pipeline, schemas, image processing, and server endpoints:

```bash
uv run pytest -v
```

---

## Packaging as a macOS Desktop App

To bundle Form 3D into a standalone macOS `.app` and `.dmg`:

```bash
./scripts/build_desktop.sh
```

The script builds the Vite frontend, Tauri v2 shell, vendors Python standalone runtime with PyTorch MPS, and outputs the installable `.dmg` to `release/`.

---

## Project Structure

```text
.
├── outputs/               # Generated 3D assets (.stl, .glb, inspection manifests)
├── schemas/               # JSON Schemas enforcing strict structured LLM output
├── scripts/               # macOS desktop packaging and build automation
│   └── build_desktop.sh
├── steps/                 # 5 modular pipeline execution steps
│   ├── step1_optimize_prompt.py
│   ├── step2_generate_image.py
│   ├── step3_process_image.py
│   ├── step4_optimize_3d.py
│   ├── step5_generate_mesh.py
│   └── agy_runner.py
├── tests/                 # Unit and end-to-end integration tests
├── ui/                    # Vite + React + Three.js + Tailwind CSS Studio interface
├── pyproject.toml         # Python project configuration & dependencies
├── run_pipeline.py        # CLI entry point
└── server.py              # FastAPI server with SSE streaming endpoints
```

---

## Contributing

Contributions, feedback, and issue reports are warmly welcomed! Please see [CONTRIBUTING.md](CONTRIBUTING.md) for development guidelines and our [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).

---

## License

This project is licensed under the [MIT License](LICENSE). Checkpoint models (such as `Tencent/Hunyuan3D-2`) are subject to their respective open-weight community licenses.
