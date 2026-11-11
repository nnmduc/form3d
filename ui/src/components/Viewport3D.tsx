"use client";

import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";

export type ShadingMode = "studio" | "clay" | "wire";
export type CameraAngle = "orbit" | "front" | "left" | "back" | "right";

interface Viewport3DProps {
  glbUrl: string;
  shading: ShadingMode;
  cameraAngle: CameraAngle;
  isDark: boolean;
  autoRotate: boolean;
}

const CAMERA_PRESETS: Record<CameraAngle, [number, number, number]> = {
  orbit: [2.05, 1.15, 2.55],
  front: [0, 0.2, 3.25],
  left: [-3.25, 0.2, 0],
  back: [0, 0.2, -3.25],
  right: [3.25, 0.2, 0],
};

export function Viewport3D({
  glbUrl,
  shading,
  cameraAngle,
  isDark,
  autoRotate,
}: Viewport3DProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [loaded, setLoaded] = useState(false);

  const sceneRef = useRef<THREE.Scene | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const controlsRef = useRef<OrbitControls | null>(null);
  const modelRootRef = useRef<THREE.Object3D | null>(null);
  const originalMaterialsRef = useRef<
    Map<THREE.Mesh, THREE.Material | THREE.Material[]>
  >(new Map());
  const targetCamPosRef = useRef<THREE.Vector3 | null>(null);
  const gridRef = useRef<THREE.PolarGridHelper | null>(null);
  const shadowMatRef = useRef<THREE.ShadowMaterial | null>(null);
  const isDarkRef = useRef(isDark);
  isDarkRef.current = isDark;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    setLoaded(false);
    const width = container.clientWidth || window.innerWidth;
    const height = container.clientHeight || window.innerHeight;

    const scene = new THREE.Scene();
    sceneRef.current = scene;

    const camera = new THREE.PerspectiveCamera(34, width / height, 0.1, 100);
    camera.position.set(...CAMERA_PRESETS.orbit);
    cameraRef.current = camera;

    const renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: true,
      powerPreference: "high-performance",
    });
    renderer.setSize(width, height);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.08;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    container.innerHTML = "";
    container.appendChild(renderer.domElement);

    const pmremGenerator = new THREE.PMREMGenerator(renderer);
    scene.environment = pmremGenerator.fromScene(
      new RoomEnvironment(),
      0.04
    ).texture;

    const keyLight = new THREE.DirectionalLight(0xffffff, 2.2);
    keyLight.position.set(3.5, 6.0, 4.5);
    keyLight.castShadow = true;
    keyLight.shadow.mapSize.set(1024, 1024);
    keyLight.shadow.radius = 4;
    keyLight.shadow.bias = -0.0005;
    scene.add(keyLight);

    const fillLight = new THREE.DirectionalLight(0xdbeafe, 1.1);
    fillLight.position.set(-4.0, 2.5, -2.5);
    scene.add(fillLight);

    const rimLight = new THREE.DirectionalLight(0xffffff, 0.9);
    rimLight.position.set(0, 4.0, -5.0);
    scene.add(rimLight);

    // Subtle circular studio plinth grid
    const polarGrid = new THREE.PolarGridHelper(
      1.35,
      12,
      6,
      64,
      isDarkRef.current ? 0x27272a : 0xd4d4d8,
      isDarkRef.current ? 0x18181b : 0xe4e4e7
    );
    polarGrid.position.y = -0.82;
    scene.add(polarGrid);
    gridRef.current = polarGrid;

    // Soft shadow catcher plane
    const shadowMat = new THREE.ShadowMaterial({
      opacity: isDarkRef.current ? 0.28 : 0.11,
    });
    shadowMatRef.current = shadowMat;
    const shadowPlane = new THREE.Mesh(
      new THREE.PlaneGeometry(6, 6),
      shadowMat
    );
    shadowPlane.rotation.x = -Math.PI / 2;
    shadowPlane.position.y = -0.821;
    shadowPlane.receiveShadow = true;
    scene.add(shadowPlane);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.06;
    controls.enablePan = false;
    controls.minDistance = 1.4;
    controls.maxDistance = 5.5;
    controls.maxPolarAngle = Math.PI / 2 + 0.08;
    controls.target.set(0, 0.02, 0);
    controls.autoRotate = autoRotate;
    controls.autoRotateSpeed = 1.1;
    controlsRef.current = controls;

    const cancelCameraPresetLerp = () => {
      targetCamPosRef.current = null;
    };
    controls.addEventListener("start", cancelCameraPresetLerp);

    let isDisposed = false;
    const loader = new GLTFLoader();
    loader.load(
      glbUrl,
      (gltf) => {
        if (isDisposed) return;
        const root = gltf.scene;

        // Our pipeline exports Z-up meshes seated at Z=0 (for 3D printing slicers).
        // Rotate -90 deg around X so +Z (height) becomes +Y (up in Three.js) and -Y (front) becomes +Z (front camera).
        const rawBox = new THREE.Box3().setFromObject(root);
        if (rawBox.min.z >= -0.5 && rawBox.max.z > rawBox.max.y * 1.1) {
          root.rotation.x = -Math.PI / 2;
          root.updateMatrixWorld(true);
        }

        // Normalize bounding box to fit centered studio pedestal
        const box = new THREE.Box3().setFromObject(root);
        const size = box.getSize(new THREE.Vector3());
        const maxDim = Math.max(size.x, size.y, size.z) || 1;
        const scale = 1.48 / maxDim;
        root.scale.setScalar(scale);
        root.updateMatrixWorld(true);

        const scaledBox = new THREE.Box3().setFromObject(root);
        const center = scaledBox.getCenter(new THREE.Vector3());
        root.position.x -= center.x;
        root.position.z -= center.z;
        root.position.y -= scaledBox.min.y + 0.82;

        const studioMat = new THREE.MeshStandardMaterial({
          color: 0x7dd3ae,
          roughness: 0.36,
          metalness: 0.08,
        });

        originalMaterialsRef.current.clear();
        root.traverse((node) => {
          if ((node as THREE.Mesh).isMesh) {
            const mesh = node as THREE.Mesh;
            mesh.castShadow = true;
            mesh.receiveShadow = true;
            mesh.geometry.computeVertexNormals();
            mesh.material = studioMat;
            originalMaterialsRef.current.set(mesh, studioMat);
          }
        });

        scene.add(root);
        modelRootRef.current = root;
        setLoaded(true);
      },
      undefined,
      () => {
        if (isDisposed) return;
        setLoaded(true);
      }
    );

    let frameId = 0;
    const animate = () => {
      frameId = requestAnimationFrame(animate);
      if (targetCamPosRef.current) {
        camera.position.lerp(targetCamPosRef.current, 0.09);
        if (camera.position.distanceTo(targetCamPosRef.current) < 0.015) {
          targetCamPosRef.current = null;
        }
      }
      controls.update();
      renderer.render(scene, camera);
    };
    animate();

    const handleResize = () => {
      if (!container) return;
      const w = container.clientWidth || window.innerWidth;
      const h = container.clientHeight || window.innerHeight;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
    };
    window.addEventListener("resize", handleResize);

    return () => {
      isDisposed = true;
      cancelAnimationFrame(frameId);
      window.removeEventListener("resize", handleResize);
      controls.removeEventListener("start", cancelCameraPresetLerp);
      controls.dispose();
      pmremGenerator.dispose();
      renderer.dispose();
    };
  }, [glbUrl]);

  // Update studio plinth grid and shadow catcher when theme toggles
  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene) return;

    if (gridRef.current) {
      scene.remove(gridRef.current);
      gridRef.current.geometry.dispose();
    }
    const nextGrid = new THREE.PolarGridHelper(
      1.35,
      12,
      6,
      64,
      isDark ? 0x27272a : 0xd4d4d8,
      isDark ? 0x18181b : 0xe4e4e7
    );
    nextGrid.position.y = -0.82;
    scene.add(nextGrid);
    gridRef.current = nextGrid;

    if (shadowMatRef.current) {
      shadowMatRef.current.opacity = isDark ? 0.28 : 0.11;
      shadowMatRef.current.needsUpdate = true;
    }
  }, [isDark]);

  // Sync auto-rotate
  useEffect(() => {
    if (controlsRef.current) {
      controlsRef.current.autoRotate = autoRotate && cameraAngle === "orbit";
    }
  }, [autoRotate, cameraAngle]);

  // Sync camera preset angle
  useEffect(() => {
    const coords = CAMERA_PRESETS[cameraAngle];
    targetCamPosRef.current = new THREE.Vector3(...coords);
    if (controlsRef.current) {
      controlsRef.current.target.set(0, 0.02, 0);
      controlsRef.current.autoRotate = autoRotate && cameraAngle === "orbit";
    }
  }, [cameraAngle, autoRotate]);

  // Sync shading mode (Studio PBR / Matte Clay / Precision Wireframe)
  useEffect(() => {
    const root = modelRootRef.current;
    if (!root) return;

    const clayMat = new THREE.MeshStandardMaterial({
      color: isDark ? 0xd4d4d8 : 0xe4e4e7,
      roughness: 0.48,
      metalness: 0.06,
    });

    const wireMat = new THREE.MeshStandardMaterial({
      color: isDark ? 0x38bdf8 : 0x0284c7,
      roughness: 0.4,
      metalness: 0.1,
      wireframe: true,
    });

    root.traverse((node) => {
      if ((node as THREE.Mesh).isMesh) {
        const mesh = node as THREE.Mesh;
        if (shading === "studio") {
          const orig = originalMaterialsRef.current.get(mesh);
          if (orig) mesh.material = orig;
        } else if (shading === "clay") {
          mesh.material = clayMat;
        } else if (shading === "wire") {
          mesh.material = wireMat;
        }
      }
    });

    return () => {
      clayMat.dispose();
      wireMat.dispose();
    };
  }, [shading, isDark, loaded]);

  return (
    <div className="relative w-full h-full select-none">
      <div
        ref={containerRef}
        className="w-full h-full cursor-grab active:cursor-grabbing"
      />
      {!loaded && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <div className="w-24 h-24 rounded-full border border-zinc-300/60 dark:border-zinc-700/60 animate-pulse" />
        </div>
      )}
    </div>
  );
}
