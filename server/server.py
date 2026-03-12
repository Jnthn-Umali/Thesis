import io
import json
import os
import ssl
import shutil
import subprocess
import tempfile
import threading
import time
from pathlib import Path
from typing import Optional, Tuple
import certifi
import sys

# Make local Depth-Anything-V2 repo importable BEFORE importing from it.
DEPTH_ANYTHING_REPO_ROOT = r"C:\Users\maref\Downloads\Depth-Anything-V2"
if DEPTH_ANYTHING_REPO_ROOT not in sys.path:
    sys.path.insert(0, DEPTH_ANYTHING_REPO_ROOT)

# Import the METRIC version of DepthAnythingV2 from the metric_depth package
from metric_depth.depth_anything_v2.dpt import DepthAnythingV2

import cv2
import numpy as np
import torch
from fastapi import FastAPI, File, UploadFile, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from PIL import Image
from transformers import pipeline
from ultralytics import YOLO
import easyocr

# Fix SSL certificate verification for urllib (needed for EasyOCR model downloads on Windows)
# Use certifi certificates for SSL verification
try:
    ssl._create_default_https_context = lambda: ssl.create_default_context(cafile=certifi.where())
except Exception:
    # Fallback to unverified if certifi fails (not recommended for production)
    ssl._create_default_https_context = ssl._create_unverified_context

# Fix for PyTorch 2.6+ weights_only issue
original_torch_load = torch.load
def patched_torch_load(*args, **kwargs):
    kwargs.setdefault('weights_only', False)
    return original_torch_load(*args, **kwargs)
torch.load = patched_torch_load

# Config
MAX_IMAGE_SIZE_MB = 1
RATE_LIMIT_PER_SEC = 1
LABELS_FILE = Path(__file__).parent / "assets/labels_oiv7_600.json"
HEIGHT_ESTIMATES_FILE = Path(__file__).parent / "assets/height_estimates.json"
FILTERED_LABELS_FILE = Path(__file__).parent / "assets/filtered_labels.json"

# Physical distance calibration parameters
# Tuned for M5Stack Timer Camera X (ESP32 + OV3660, ~66° FOV)
# These can be refined further if you measure your exact module.
CAMERA_FOCAL_LENGTH_MM = 4.8   # Approximate OV3660 focal length
SENSOR_WIDTH_MM = 3.6          # Approximate OV3660 sensor width
REFERENCE_OBJECT_HEIGHT_MM = 1700  # Average human height for calibration

# Global correction factor to tweak all physical distance estimates together.
# 1.5 = add 50% to distance; 0.5 = halve. Tune with real-world test shots.
DISTANCE_CORRECTION_FACTOR = 0.5

# Small object detection parameters
SMALL_OBJECT_HEIGHT_THRESHOLD_MM = 500  # Objects with height < 500mm are considered "small"
SMALL_OBJECT_BBOX_HEIGHT_THRESHOLD = 0.03  # If small object bbox height > 3% of image, it's likely close
SMALL_OBJECT_MAX_DISTANCE_M = 3.0  # Maximum distance cap for small objects that appear reasonably large in frame

# Human posture (sitting vs standing): labels that use posture-aware height
HUMAN_LABELS = {"person", "man", "woman", "boy", "girl"}
# Labels that often fill the frame (e.g. door); skip near-field override so distance can vary (not stuck at 0-4 ft).
NEAR_FIELD_EXCLUDE_LABELS = {"door", "door handle"}
# Minimum reported distance for door-like objects so they don't always show "0-4 ft" when close (meters).
DOOR_MIN_DISTANCE_M = 1.5
# If bbox aspect ratio (height/width) is below this, treat as sitting (shorter visible height)
SITTING_ASPECT_RATIO_THRESHOLD = 1.0
# Sitting effective height as fraction of standing height (head-to-seat ~0.6–0.65 of full height)
SITTING_HEIGHT_FRACTION = 0.6

app = FastAPI()
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

# Load labels if present
labels: Optional[list[str]] = None
if LABELS_FILE.exists():
    with open(LABELS_FILE, "r", encoding="utf-8") as f:
        labels = json.load(f)
    print(f"Loaded {len(labels)} labels")
else:
    print(f"Labels file not found at {LABELS_FILE}")

# Load filtered labels (labels to ignore) if present
filtered_labels: set[str] = set()
if FILTERED_LABELS_FILE.exists():
    try:
        with open(FILTERED_LABELS_FILE, "r", encoding="utf-8") as f:
            _filtered = json.load(f)
        if isinstance(_filtered, list):
            filtered_labels = {str(x).strip().lower() for x in _filtered if str(x).strip()}
        print(f"Loaded {len(filtered_labels)} filtered labels")
    except Exception as e:
        print(f"Failed to load filtered labels from {FILTERED_LABELS_FILE}: {e}")
else:
    print(f"Filtered labels file not found at {FILTERED_LABELS_FILE}")

# Load height estimates if present
height_estimates: Optional[dict[str, float]] = None
if HEIGHT_ESTIMATES_FILE.exists():
    with open(HEIGHT_ESTIMATES_FILE, "r", encoding="utf-8") as f:
        height_estimates = json.load(f)
    print(f"Loaded {len(height_estimates)} height estimates")
else:
    print(f"Height estimates file not found at {HEIGHT_ESTIMATES_FILE}")

# Load PyTorch model (YOLOv8s trained on OIV7 dataset with 600 classes)
model = YOLO('yolov8m-oiv7.pt')

last_request_time = 0

# Load metric depth estimation model (Depth Anything V2 metric)
print("Loading metric depth estimation model (Depth Anything V2)...")
DEVICE = 'cuda' if torch.cuda.is_available() else 'mps' if torch.backends.mps.is_available() else 'cpu'
METRIC_CHECKPOINT = r"C:\Users\maref\Downloads\Depth-Anything-V2\metric_depth\checkpoints\depth_anything_v2_metric_hypersim_vitb.pth"
try:
    # Model config for vitb (Base)
    model_config = {'encoder': 'vitb', 'features': 128, 'out_channels': [96, 192, 384, 768]}
    metric_depth_model = DepthAnythingV2(**model_config, max_depth=20.0)
    metric_depth_model.load_state_dict(torch.load(METRIC_CHECKPOINT, map_location='cpu'))
    metric_depth_model = metric_depth_model.to(DEVICE).eval()
    print(f"Metric depth model loaded successfully: {METRIC_CHECKPOINT}")
    print(f"Using device: {DEVICE}")
except Exception as e:
    print(f"Failed to load metric depth model: {e}")
    import traceback
    traceback.print_exc()
    metric_depth_model = None

# Initialize EasyOCR reader (English only)
print("Loading EasyOCR reader (English)...")
ocr_reader = easyocr.Reader(['en'], gpu=torch.cuda.is_available())
print("EasyOCR reader loaded successfully!")



def detect_upside_down_text(pil_image: Image.Image) -> bool:
    """
    Detect if text in the image is upside down by comparing OCR confidence
    between original and 180-degree rotated versions.
    Returns True if text appears to be upside down.
    """
    try:
        rgb = pil_image.convert("RGB")
        image_np = np.array(rgb)

        # Run OCR on original image
        results_original = ocr_reader.readtext(image_np, detail=1)
        if not results_original:
            return False  # No text detected, can't determine orientation
        
        # Calculate average confidence for original
        confidences_original = [conf for (_, _, conf) in results_original if conf > 0.4]
        if not confidences_original:
            return False
        
        avg_conf_original = sum(confidences_original) / len(confidences_original)
        
        # Rotate image 180 degrees
        rotated_image = pil_image.rotate(180, expand=False)
        rotated_np = np.array(rotated_image.convert("RGB"))
        
        # Run OCR on rotated image
        results_rotated = ocr_reader.readtext(rotated_np, detail=1)
        if not results_rotated:
            return False  # No text detected in rotated version
        
        # Calculate average confidence for rotated
        confidences_rotated = [conf for (_, _, conf) in results_rotated if conf > 0.4]
        if not confidences_rotated:
            return False
        
        avg_conf_rotated = sum(confidences_rotated) / len(confidences_rotated)
        
        # If rotated version has significantly higher confidence (>0.15 difference),
        # the original text is likely upside down
        is_upside_down = avg_conf_rotated > avg_conf_original + 0.15
        
        if is_upside_down:
            print(f"Upside-down text detected: original conf={avg_conf_original:.3f}, rotated conf={avg_conf_rotated:.3f}")
        
        return is_upside_down
    except Exception as e:
        print(f"Upside-down detection error: {e}")
        return False


def extract_text_from_full_image(pil_image: Image.Image) -> Tuple[str, bool]:
    """
    Run EasyOCR on the full image.
    This works even when YOLO finds no objects.
    Returns tuple of (text, is_upside_down).
    """
    try:
        rgb = pil_image.convert("RGB")
        image_np = np.array(rgb)

        results = ocr_reader.readtext(image_np, detail=1)
        texts = [text for (_, text, conf) in results if text and conf > 0.4]
        extracted_text = " ".join(texts).strip()
        
        # Detect if text is upside down (only if we found text)
        is_upside_down = False
        if extracted_text:
            is_upside_down = detect_upside_down_text(pil_image)
        
        return extracted_text, is_upside_down
    except Exception as e:
        print(f"Full-image OCR error: {e}")
        return "", False


def extract_text_from_detection(pil_image: Image.Image, detection: dict) -> Tuple[str, bool]:
    """
    Run EasyOCR on the region defined by a detection's bounding box.
    English only, best-effort (may return empty string if no readable text).
    Returns tuple of (text, is_upside_down).
    """
    try:
        bbox = detection.get("boundingBox", {})
        x1 = int(max(0, bbox.get("x1", 0)))
        y1 = int(max(0, bbox.get("y1", 0)))
        x2 = int(max(x1 + 1, bbox.get("x2", x1 + 1)))
        y2 = int(max(y1 + 1, bbox.get("y2", y1 + 1)))

        # Clamp to image bounds
        width, height = pil_image.size
        x1 = max(0, min(x1, width - 1))
        x2 = max(1, min(x2, width))
        y1 = max(0, min(y1, height - 1))
        y2 = max(1, min(y2, height))

        if x2 <= x1 or y2 <= y1:
            return "", False

        crop = pil_image.crop((x1, y1, x2, y2)).convert("RGB")

        # Upscale very small crops to help OCR
        cw, ch = crop.size
        if min(cw, ch) < 64:
            scale = 2
            crop = crop.resize((cw * scale, ch * scale), Image.LANCZOS)

        crop_np = np.array(crop)

        results = ocr_reader.readtext(crop_np, detail=1)
        texts = [text for (_, text, conf) in results if text and conf > 0.4]
        extracted_text = " ".join(texts).strip()
        
        # Detect if text is upside down (only if we found text)
        is_upside_down = False
        if extracted_text:
            is_upside_down = detect_upside_down_text(crop)
        
        return extracted_text, is_upside_down
    except Exception as e:
        print(f"OCR error: {e}")
        return "", False

def predict_with_model(image_bytes: bytes):
    """Use Ultralytics YOLO directly for accurate predictions - returns all detections"""
    # Save image temporarily
    temp_path = "temp_image.jpg"
    with open(temp_path, "wb") as f:
        f.write(image_bytes)
    
    try:
        # Run prediction
        results = model(temp_path)
        
        # Get all detections
        if results and len(results) > 0:
            result = results[0]
            boxes = result.boxes
            
            if boxes is not None and len(boxes) > 0:
                # Get all detections above confidence threshold
                confidences = boxes.conf.cpu().numpy()
                classes = boxes.cls.cpu().numpy()
                box_coords = boxes.xyxy.cpu().numpy()  # Get bounding box coordinates
                
                detections = []
                for i in range(len(confidences)):
                    confidence = float(confidences[i])
                    class_idx = int(classes[i])
                    
                    # Apply confidence threshold
                    if confidence >= 0.25:
                        # Get label
                        label = labels[class_idx] if class_idx < len(labels) else f"Class {class_idx}"

                        # Filter out unwanted labels (exact match after normalization)
                        # Note: labels in labels_oiv7_600.json are lowercase already, but normalize anyway.
                        label_norm = str(label).strip().lower()
                        if label_norm in filtered_labels:
                            continue
                        
                        # Calculate center position from bounding box
                        x1, y1, x2, y2 = box_coords[i]
                        center_x = (x1 + x2) / 2
                        center_y = (y1 + y2) / 2
                        
                        detections.append({
                            "classIndex": class_idx,
                            "confidence": confidence,
                            "label": label,
                            "centerX": float(center_x),
                            "centerY": float(center_y),
                            "boundingBox": {
                                "x1": float(x1),
                                "y1": float(y1),
                                "x2": float(x2),
                                "y2": float(y2),
                                "width": float(x2 - x1),
                                "height": float(y2 - y1)
                            }
                        })
                
                # Post-process detections:
                # If a laptop is present in the scene, drop standalone keyboard detections.
                # This avoids announcing both "laptop" and "keyboard" for the same physical device.
                has_laptop = any("laptop" in str(d["label"]).strip().lower() for d in detections)
                if has_laptop:
                    detections = [
                        d
                        for d in detections
                        if "keyboard" not in str(d["label"]).strip().lower()
                    ]
                
                # If multiple doors are detected, keep only the one with highest confidence.
                door_detections = [d for d in detections if "door" in str(d["label"]).strip().lower()]
                if len(door_detections) > 1:
                    # Find the door with highest confidence
                    best_door = max(door_detections, key=lambda x: x["confidence"])
                    # Remove all doors from detections
                    detections = [d for d in detections if "door" not in str(d["label"]).strip().lower()]
                    # Add back only the best door
                    detections.append(best_door)
                
                # Sort by confidence (highest first); limit applied later in /infer by MiDaS nearest
                detections.sort(key=lambda x: x["confidence"], reverse=True)
                return detections[:10]
        
        return []
        
    finally:
        # Clean up temp file
        import os
        if os.path.exists(temp_path):
            os.remove(temp_path)

def estimate_depth(image_bytes: bytes) -> Tuple[Optional[float], Optional[np.ndarray]]:
    """Estimate metric depth map in meters and return normalized "closeness" (0-1, higher=closer) for compatibility."""
    try:
        if metric_depth_model is None:
            print("Metric depth model not loaded, returning None")
            return None, None
        
        # Convert bytes to PIL Image, then to OpenCV BGR format (as expected by Depth Anything)
        image_pil = Image.open(io.BytesIO(image_bytes))
        image_rgb = np.array(image_pil.convert("RGB"))
        image_bgr = cv2.cvtColor(image_rgb, cv2.COLOR_RGB2BGR)
        
        # Run metric depth estimation (returns depth map in meters)
        depth_map_meters = metric_depth_model.infer_image(image_bgr, input_size=518)
        
        # depth_map_meters is already a numpy array in meters (H x W)
        # Calculate average depth for logging/compatibility
        avg_depth_meters = float(np.mean(depth_map_meters))
        
        # Normalize to 0-1 "closeness" for backward compatibility (invert: closer = higher)
        max_depth_meters = float(np.max(depth_map_meters)) or 1.0
        normalized_closeness = 1.0 - (avg_depth_meters / max_depth_meters) if max_depth_meters > 0 else 0.5
        
        return normalized_closeness, depth_map_meters
        
    except Exception as e:
        print(f"Metric depth estimation error: {e}")
        import traceback
        traceback.print_exc()
        return None, None

def get_object_midas_depth(depth_map: np.ndarray, bbox: dict, image_width: int, image_height: int) -> float:
    """
    Extract metric depth value (in meters) specifically for an object's bounding box region.
    Uses median depth within the bounding box for more robust estimation.
    
    Args:
        depth_map: Full image metric depth map (in meters)
        bbox: Bounding box dict with x1, y1, x2, y2
        image_width: Original image width
        image_height: Original image height
    
    Returns:
        Normalized depth value (0-1, higher = closer) for backward compatibility
        Note: The depth_map is now in meters, but we still return normalized for compatibility
    """
    try:
        if depth_map is None:
            return 0.5  # Default if no depth map
        
        h, w = depth_map.shape
        
        # Convert bounding box coordinates to depth map coordinates
        x1 = int(max(0, min(bbox.get("x1", 0) * w / image_width, w - 1)))
        y1 = int(max(0, min(bbox.get("y1", 0) * h / image_height, h - 1)))
        x2 = int(max(x1 + 1, min(bbox.get("x2", image_width) * w / image_width, w)))
        y2 = int(max(y1 + 1, min(bbox.get("y2", image_height) * h / image_height, h)))
        
        # Extract depth region for this object (now in meters)
        object_depth_region = depth_map[y1:y2, x1:x2]
        
        if object_depth_region.size == 0:
            return 0.5
        
        # Use median depth (more robust than mean for noisy regions)
        median_depth_meters = float(np.median(object_depth_region))
        max_depth_meters = float(np.max(depth_map))
        
        # Normalize: invert so closer = higher value (0-1 scale)
        if max_depth_meters > 0:
            normalized_depth = 1.0 - (median_depth_meters / max_depth_meters)
        else:
            normalized_depth = 0.5
        
        return max(0.0, min(1.0, normalized_depth))
        
    except Exception as e:
        print(f"Object metric depth extraction error: {e}")
        return 0.5  # Default fallback

def get_object_metric_depth_meters(
    depth_map: np.ndarray,
    bbox: dict,
    image_width: int,
    image_height: int,
    label: str,
) -> float:
    """
    Extract metric depth value (in meters) specifically for an object's bounding box region.
    Includes cropping detection: if bbox touches image edges and is large, assume very close.
    
    Args:
        depth_map: Full image metric depth map (in meters)
        bbox: Bounding box dict with x1, y1, x2, y2
        image_width: Original image width
        image_height: Original image height
    
    Returns:
        Median depth in meters for this object
    """
    try:
        if depth_map is None:
            return 1.0  # Default fallback in meters
        
        # Only apply cropping override for human-like labels
        label_lower = (label or "").strip().lower()
        is_human_label = label_lower in HUMAN_LABELS

        # Check if bbox is cropped (touches image edges) - indicates very close object
        crop_threshold = 10  # pixels
        bbox_x1 = bbox.get("x1", 0)
        bbox_y1 = bbox.get("y1", 0)
        bbox_x2 = bbox.get("x2", image_width)
        bbox_y2 = bbox.get("y2", image_height)
        
        is_cropped = (
            bbox_x1 <= crop_threshold or
            bbox_y1 <= crop_threshold or
            bbox_x2 >= image_width - crop_threshold or
            bbox_y2 >= image_height - crop_threshold
        )
        
        # Calculate bbox area ratio to ensure it's reasonably large (not just a tiny edge detection)
        bbox_area_ratio = ((bbox_x2 - bbox_x1) * (bbox_y2 - bbox_y1)) / (image_width * image_height)
        bbox_height_ratio = (bbox_y2 - bbox_y1) / image_height
        
        # If cropped AND reasonably large AND human, force close distance (like your face filling the frame)
        if is_human_label and is_cropped and bbox_area_ratio > 0.10:
            # Very close: 0.5-0.8m range
            return 0.6  # ~2 feet, right in front
        
        h, w = depth_map.shape
        
        # Convert bounding box coordinates to depth map coordinates
        x1 = int(max(0, min(bbox_x1 * w / image_width, w - 1)))
        y1 = int(max(0, min(bbox_y1 * h / image_height, h - 1)))
        x2 = int(max(x1 + 1, min(bbox_x2 * w / image_width, w)))
        y2 = int(max(y1 + 1, min(bbox_y2 * h / image_height, h)))
        
        # Extract depth region for this object (in meters)
        object_depth_region = depth_map[y1:y2, x1:x2]
        
        if object_depth_region.size == 0:
            return 1.0  # Default fallback in meters
        
        # Use median depth (more robust than mean for noisy regions)
        median_depth_meters = float(np.median(object_depth_region))
        
        return max(0.3, min(50.0, median_depth_meters))  # Clamp to reasonable range
        
    except Exception as e:
        print(f"Object metric depth extraction error: {e}")
        return 1.0  # Default fallback in meters

def calculate_physical_distance(detection: dict, image_width: int, image_height: int) -> float:
    """
    Calculate physical distance using thin lens formula and object size estimation.
    Includes near-field detection for objects very close to camera.
    Special handling for small objects (bottles, cups, etc.) that can be close but appear small.
    
    Formula: distance = (focal_length * real_object_height * image_height) / (object_height_pixels * sensor_height)
    
    Args:
        detection: Object detection result with bounding box
        image_width: Image width in pixels
        image_height: Image height in pixels
    
    Returns:
        Distance in meters
    """
    try:
        # Get object height in pixels from bounding box
        bbox = detection["boundingBox"]
        object_height_pixels = bbox["height"]
        object_width_pixels = bbox["width"]
        
        # Calculate bounding box coverage as percentage of image
        bbox_area_ratio = (object_height_pixels * object_width_pixels) / (image_width * image_height)
        bbox_height_ratio = object_height_pixels / image_height
        
        # Estimate real object height based on detected class
        real_object_height_mm = estimate_object_height(detection["label"])

        # Human posture: if label is person/man/woman/boy/girl and bbox suggests sitting
        # (shorter aspect ratio than standing), use a smaller effective height for distance.
        label_lower = detection["label"].strip().lower()
        if label_lower in HUMAN_LABELS and object_width_pixels > 0:
            aspect_ratio = object_height_pixels / object_width_pixels
            if aspect_ratio < SITTING_ASPECT_RATIO_THRESHOLD:
                real_object_height_mm = real_object_height_mm * SITTING_HEIGHT_FRACTION
        
        # Determine if object is "small" (bottles, cups, small items)
        is_small_object = real_object_height_mm < SMALL_OBJECT_HEIGHT_THRESHOLD_MM

        # NEAR-FIELD OVERRIDE: If object takes up a very large portion of the image, it's very close.
        # Threshold: if bbox height > 45% of image OR area > 20% of image, force close distance.
        # Skip for door/door handle so their distance can vary (they often fill the frame and would otherwise always show 0-4 ft).
        if label_lower not in NEAR_FIELD_EXCLUDE_LABELS and (bbox_height_ratio > 0.45 or bbox_area_ratio > 0.20):
            return 0.75  # ~1.5 steps equivalent
        
        # Calculate sensor height (assuming 4:3 aspect ratio typical for phone cameras)
        sensor_height_mm = SENSOR_WIDTH_MM * (image_height / image_width)
        
        # Apply thin lens formula
        # distance = (focal_length * real_height * image_height) / (pixel_height * sensor_height)
        distance_mm = (CAMERA_FOCAL_LENGTH_MM * real_object_height_mm * image_height) / (object_height_pixels * sensor_height_mm)
        
        # Convert to meters
        distance_meters = distance_mm / 1000.0
        
        # Improved scaling: use milder dynamic factors based on object size and bbox size.
        # These values are intentionally in a tighter 2.0–2.8 band so that distances are
        # not overly compressed, making "1–2 steps" more reachable for close objects.
        if is_small_object:
            # Small objects: still need some scaling, but less aggressive than before.
            if bbox_height_ratio > 0.15:
                scale_factor = 2.0  # Very close small object filling a good part of the frame
            elif bbox_height_ratio > 0.08:
                scale_factor = 2.3  # Medium-sized small object
            else:
                scale_factor = 2.6  # Distant/small in frame
        elif real_object_height_mm < 1000:  # Medium objects (500–1000mm)
            if bbox_height_ratio > 0.30:
                scale_factor = 2.0
            elif bbox_height_ratio > 0.15:
                scale_factor = 2.3
            else:
                scale_factor = 2.6
        else:  # Large objects (>1000mm, e.g., person)
            if bbox_height_ratio > 0.30:
                scale_factor = 2.0
            elif bbox_height_ratio > 0.15:
                scale_factor = 2.4
            else:
                scale_factor = 2.8
        
        distance_meters = distance_meters / scale_factor

        # For small objects, enforce a slightly higher minimum; they shouldn't get
        # unrealistically close unless they truly dominate the frame.
        if is_small_object:
            distance_meters = max(0.4, distance_meters)

        # Apply global correction factor so we can tune distances end-to-end without
        # having to recalibrate all the per-class heights.
        distance_meters *= DISTANCE_CORRECTION_FACTOR

        # Apply reasonable global bounds.
        distance_meters = max(0.3, min(50.0, distance_meters))
        # Door-like objects: enforce minimum so they don't always show "0-4 ft" when close.
        if label_lower in NEAR_FIELD_EXCLUDE_LABELS and distance_meters < DOOR_MIN_DISTANCE_M:
            distance_meters = DOOR_MIN_DISTANCE_M

        return distance_meters
        
    except Exception as e:
        print(f"Physical distance calculation error: {e}")
        return 1.0  # Default to 1 meter if calculation fails

def estimate_object_height(label: str) -> float:
    """
    Estimate real-world height of detected objects in millimeters.
    Uses the loaded height estimates from JSON file.
    """
    if height_estimates is None:
        return 1000.0  # Default height if estimates not loaded
    
    # Try exact match first
    if label.lower() in height_estimates:
        return height_estimates[label.lower()]
    
    # Try partial matches for compound labels
    for key, height in height_estimates.items():
        if key in label.lower():
            return height
    
    # Return default height for unknown objects
    return 1000.0

def calibrate_depth_to_distance(depth_map: np.ndarray, reference_distance_m: float, reference_depth_value: float) -> np.ndarray:
    """
    Calibrate MiDaS depth map to physical distances using a reference point.
    
    Args:
        depth_map: Raw MiDaS depth map
        reference_distance_m: Known distance of reference object in meters
        reference_depth_value: MiDaS depth value at reference object location
    
    Returns:
        Calibrated depth map in meters
    """
    try:
        # Find the scale factor to convert MiDaS depth to physical distance
        # This is a linear relationship: physical_distance = scale * miDas_depth + offset
        scale_factor = reference_distance_m / reference_depth_value
        
        # Apply calibration to entire depth map
        calibrated_depth = depth_map * scale_factor
        
        return calibrated_depth
        
    except Exception as e:
        print(f"Depth calibration error: {e}")
        return depth_map  # Return original if calibration fails

def determine_object_position(center_x: float, image_width: int = 512) -> str:
    """Determine if object is on left, center, or right based on center_x position"""
    third = image_width / 3
    if center_x < third:
        return "left"
    elif center_x < 2 * third:
        return "center"
    else:
        return "right"

def analyze_midas_position(depth_map) -> dict:
    """Infer left/center/right using MiDaS depth only (no bounding boxes).
    Uses normalized inverse depth (closer = higher) and compares thirds of the image.
    """
    try:
        h, w = depth_map.shape
        max_val = float(np.max(depth_map)) or 1.0
        inv_norm = 1.0 - (depth_map / max_val)

        third = max(1, w // 3)
        left_region = inv_norm[:, :third]
        middle_region = inv_norm[:, third:2*third]
        right_region = inv_norm[:, 2*third:]

        left_mean = float(np.mean(left_region))
        middle_mean = float(np.mean(middle_region))
        right_mean = float(np.mean(right_region))

        # Decide dominant side; small hysteresis to avoid flicker
        margin = 0.02
        # Flip sides to match user's perspective (camera view)
        if left_mean > right_mean + margin and left_mean > middle_mean + margin:
            position = "right"
            distance = left_mean
        elif right_mean > left_mean + margin and right_mean > middle_mean + margin:
            position = "left"
            distance = right_mean
        else:
            position = "center"
            distance = middle_mean

        return {
            "position": position,
            "vertical": "none",
            "distance": float(distance),
            "center_x": 0.0,
            "center_y": 0.0,
            "x1": 0.0, "y1": 0.0, "x2": 0.0, "y2": 0.0,
            "width": 0.0, "height": 0.0
        }
    except Exception as e:
        print(f"MiDaS position analysis error: {e}")
        return {
            "position": "none",
            "vertical": "none",
            "distance": 0.0,
            "center_x": 0.0,
            "center_y": 0.0,
            "x1": 0.0, "y1": 0.0, "x2": 0.0, "y2": 0.0,
            "width": 0.0, "height": 0.0
        }


@app.post("/infer")
async def infer(file: UploadFile = File(...), request: Request = None):
    global last_request_time
    now = time.time()
    if now - last_request_time < 1.0 / RATE_LIMIT_PER_SEC:
        raise HTTPException(status_code=429, detail="Too Many Requests")
    last_request_time = now

    content = await file.read()
    print(f"Received image: {len(content)} bytes")
    
    if len(content) > MAX_IMAGE_SIZE_MB * 1024 * 1024:
        raise HTTPException(status_code=413, detail="File too large")

    try:
        # Get image dimensions for physical distance calculation
        image = Image.open(io.BytesIO(content))
        image_width, image_height = image.size
        
        # Object detection - get all detections
        detections = predict_with_model(content)
        print(f"Found {len(detections)} objects")
        
        # Depth estimation (metric depth in meters)
        depth_value, depth_map = estimate_depth(content)
        if depth_map is not None:
            avg_depth_m = float(np.mean(depth_map))
            print(f"Metric depth map: avg={avg_depth_m:.2f}m, normalized closeness={depth_value:.3f}")
        else:
            print(f"Depth estimation failed or not available")

        # Infer dominant left/center/right position from MiDaS depth map
        midas_position = analyze_midas_position(depth_map) if depth_map is not None else None

        # Global OCR on the full image (works even if YOLO finds no objects)
        full_ocr_text, full_ocr_upside_down = extract_text_from_full_image(image)
        if full_ocr_text:
            print(f"Full-image OCR text (truncated to 200 chars): {full_ocr_text[:200]!r}")
            if full_ocr_upside_down:
                print("WARNING: Full-image text appears to be upside down!")
        
        # Process each detection with position, physical distance, and OCR text
        processed_objects = []
        for detection in detections:
            # Determine position based on center_x
            position = determine_object_position(detection["centerX"], image_width)
            
            # Calculate physical distance using thin lens formula (with near-field detection)
            physical_distance_m = calculate_physical_distance(detection, image_width, image_height)
            
            # Get object-specific metric depth in meters from bounding box region
            metric_depth_meters = get_object_metric_depth_meters(
                depth_map,
                detection["boundingBox"],
                image_width,
                image_height,
                detection["label"],
            ) if depth_map is not None else None
            
            # Also get normalized closeness for backward compatibility
            object_midas_depth = get_object_midas_depth(
                depth_map, 
                detection["boundingBox"], 
                image_width, 
                image_height
            ) if depth_map is not None else (depth_value if depth_value is not None else 0.5)
            
            # Fallback to global depth if object-specific failed
            midas_distance = object_midas_depth

            # Run OCR on this detection's bounding box (English only)
            ocr_text, ocr_upside_down = extract_text_from_detection(image, detection)
            if ocr_text:
                print(f"OCR for object '{detection['label']}' (truncated to 120 chars): {ocr_text[:120]!r}")
                if ocr_upside_down:
                    print(f"WARNING: Text for '{detection['label']}' appears to be upside down!")
            
            # Calculate bounding box size ratios for client-side handling
            bbox = detection["boundingBox"]
            bbox_height_ratio = bbox["height"] / image_height
            bbox_area_ratio = (bbox["height"] * bbox["width"]) / (image_width * image_height)
            
            # Determine if object is small for client-side handling
            real_object_height_mm = estimate_object_height(detection["label"])
            is_small_object = real_object_height_mm < SMALL_OBJECT_HEIGHT_THRESHOLD_MM

            # Metric depth (Depth Anything V2) is our PRIMARY distance source.
            # If metric depth is available, use it directly (in meters). Otherwise, fall back to physical.
            if metric_depth_meters is not None:
                object_distance_m = max(0.3, min(50.0, float(metric_depth_meters)))
                distance_model = "metric_only"
                recommended_source = "metric"
                depth_based_distance_m = object_distance_m
            else:
                object_distance_m = float(physical_distance_m)
                distance_model = "physical_only"
                recommended_source = "physical"
                depth_based_distance_m = object_distance_m
            
            processed_obj = {
                "classIndex": detection["classIndex"],
                "confidence": detection["confidence"],
                "label": detection["label"],
                "position": position,
                "vertical": "none",
                # Primary distance used by the client (metric depth when available, in meters).
                "objectDistance": float(object_distance_m),
                # Keep the thin-lens physical estimate for debugging/comparison.
                "physicalDistance": float(physical_distance_m),
                "midasDistance": float(midas_distance),  # Object-specific depth "closeness" (0-1)
                "depthDistance": float(depth_based_distance_m),  # Depth-only approximate meters
                "distanceModel": distance_model,
                "ocrText": ocr_text,
                "ocrUpsideDown": bool(ocr_upside_down),  # Flag indicating if OCR text is upside down
                "centerX": detection["centerX"],
                "centerY": detection["centerY"],
                "boundingBox": detection["boundingBox"],
                "estimatedHeight": float(real_object_height_mm / 1000.0),  # Height in meters
                "bboxHeightRatio": float(bbox_height_ratio),  # For near-field detection
                "bboxAreaRatio": float(bbox_area_ratio),  # For near-field detection
                "isSmallObject": bool(is_small_object),  # Flag for client-side small object handling
                "recommendedDistanceSource": recommended_source,
            }
            processed_objects.append(processed_obj)
            metric_info = f", metric depth: {metric_depth_meters:.2f}m" if metric_depth_meters is not None else ", metric depth: N/A"
            print(
                f"Object: {detection['label']} at {position}, physical: {physical_distance_m:.2f}m, chosen: {object_distance_m:.2f}m"
                f"{metric_info}, normalized closeness: {midas_distance:.3f}, bbox height ratio: {bbox_height_ratio:.2f}, confidence: {detection['confidence']:.3f}"
            )
        
        # Keep only the 4 nearest objects by MiDaS depth (higher = closer)
        processed_objects.sort(key=lambda x: x["midasDistance"], reverse=True)
        processed_objects = processed_objects[:4]

        return {
            "objects": processed_objects,
            "depth": depth_value,
            "midasDepth": depth_value,  # Keep for backward compatibility
            "midasPosition": midas_position,
            "totalObjects": len(processed_objects),
            "fullOcrText": full_ocr_text,
            "fullOcrUpsideDown": bool(full_ocr_upside_down),  # Flag indicating if full-image OCR text is upside down
            "imageDimensions": {
                "width": image_width,
                "height": image_height
            },
            "cameraCalibration": {
                "focalLengthMm": CAMERA_FOCAL_LENGTH_MM,
                "sensorWidthMm": SENSOR_WIDTH_MM
            }
        }       
    except Exception as e:
        print(f"Error: {e}")
        return JSONResponse(status_code=500, content={"error": str(e)})

@app.get("/health")
def health():
    return {"status": "ok"}

@app.post("/calibrate")
async def calibrate_camera(
    file: UploadFile = File(...),
    reference_distance_m: float = 2.0,
    reference_object_label: str = "person"
):
    """
    Calibrate camera parameters using a reference object at known distance.
    
    Args:
        file: Image containing reference object
        reference_distance_m: Known distance to reference object in meters
        reference_object_label: Label of the reference object (e.g., "person")
    
    Returns:
        Calibration results and updated parameters
    """
    try:
        content = await file.read()
        image = Image.open(io.BytesIO(content))
        image_width, image_height = image.size
        
        # Get detections
        detections = predict_with_model(content)
        
        # Find reference object
        reference_detection = None
        for detection in detections:
            if reference_object_label.lower() in detection["label"].lower():
                reference_detection = detection
                break
        
        if not reference_detection:
            return JSONResponse(
                status_code=400, 
                content={"error": f"Reference object '{reference_object_label}' not found in image"}
            )
        
        # Calculate current distance estimate
        current_distance = calculate_physical_distance(reference_detection, image_width, image_height)
        
        # Calculate calibration factor
        calibration_factor = reference_distance_m / current_distance
        
        # Update global calibration parameters
        global CAMERA_FOCAL_LENGTH_MM
        CAMERA_FOCAL_LENGTH_MM *= calibration_factor
        
        return {
            "status": "calibrated",
            "referenceObject": {
                "label": reference_detection["label"],
                "confidence": reference_detection["confidence"],
                "actualDistance": reference_distance_m,
                "estimatedDistance": current_distance,
                "calibrationFactor": calibration_factor
            },
            "updatedParameters": {
                "focalLengthMm": CAMERA_FOCAL_LENGTH_MM,
                "sensorWidthMm": SENSOR_WIDTH_MM
            },
            "message": f"Camera calibrated using {reference_object_label} at {reference_distance_m}m"
        }
        
    except Exception as e:
        print(f"Calibration error: {e}")
        return JSONResponse(status_code=500, content={"error": str(e)})

@app.get("/calibration")
def get_calibration():
    """Get current camera calibration parameters"""
    return {
        "focalLengthMm": CAMERA_FOCAL_LENGTH_MM,
        "sensorWidthMm": SENSOR_WIDTH_MM,
        "referenceObjectHeightMm": REFERENCE_OBJECT_HEIGHT_MM
    }

if __name__ == "__main__":
    import uvicorn
    print("Starting server on http://0.0.0.0:8000")
    print("Access from phone: http://5:8000")
    uvicorn.run(app, host="0.0.0.0", port=8000)