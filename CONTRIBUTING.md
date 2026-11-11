# Contributing to Form 3D

Thank you for your interest in contributing to **Form 3D**! We welcome bug reports, feature requests, documentation improvements, and pull requests.

## Code of Conduct

All contributors and participants are expected to follow our [Code of Conduct](CODE_OF_CONDUCT.md). Please treat everyone with respect and kindness.

## Development Setup

### 1. Prerequisites

- **macOS Apple Silicon** (M1/M2/M3/M4) recommended for local Metal GPU inference (`mps`), or a remote Linux host with NVIDIA CUDA.
- **Python 3.11** (managed seamlessly via [`uv`](https://docs.astral.sh/uv/)).
- **Node.js 20+** and `npm` for the React/Three.js frontend.
- **Antigravity CLI (`agy`)**: Required for Step 1 prompt optimization and Step 2 multi-view turnaround sheet generation.

### 2. Clone and Setup Environment

```bash
# Clone the repository
git clone https://github.com/layerzero-dev/form3d.git
cd form3d

# Install Python virtual environment & dependencies
uv sync

# Install Frontend dependencies
cd ui
npm install
cd ..
```

### 3. Verify Local Setup & Tests

Run the unit and integration test suite:

```bash
uv run pytest -v
```

All 11 tests should pass.

### 4. Running the Development Server

Start the FastAPI backend:
```bash
uv run python server.py
```

In another terminal, start the UI dev server:
```bash
cd ui
npm run dev
```

Open `http://localhost:5173` in your browser.

## Making Changes & Submitting Pull Requests

1. **Create a Topic Branch**:
   ```bash
   git checkout -b feat/your-feature-name
   ```
2. **Follow Coding Standards**:
   - Python: Follow PEP 8 guidelines and include type hints (`mypy`/type-safe annotations).
   - TypeScript/React: Run `npm run build` inside `ui/` to ensure clean type-checking and bundling.
3. **Write and Update Tests**:
   - If adding a feature or fixing a bug, add corresponding unit tests in `tests/`.
   - Ensure all tests pass: `uv run pytest -v`.
4. **Commit Messages**:
   - We follow [Conventional Commits](https://www.conventionalcommits.org/):
     - `feat: ...` for new features
     - `fix: ...` for bug fixes
     - `docs: ...` for documentation changes
     - `refactor: ...` for code refactoring
     - `test: ...` for test suite additions/updates
5. **Open a Pull Request**:
   - Provide a clear description of the problem solved and link any relevant issues.
   - Describe verification steps taken.

## Reporting Security Issues

Please review our [Security Policy](SECURITY.md) for instructions on reporting vulnerabilities responsibly.
