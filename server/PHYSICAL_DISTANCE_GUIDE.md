# Physical Distance Measurement Guide

## Overview

The server now provides **true physical distance measurements** in meters instead of relative depth values. This is achieved using the **thin lens formula** combined with object size estimation.

## How It Works

### 1. **Thin Lens Formula**
```
distance = (focal_length × real_object_height × image_height) / (object_height_pixels × sensor_height)
```

### 2. **Object Height Estimation**
- Uses a lookup table of common object heights
- Estimates real-world height based on detected object class
- Falls back to default height for unknown objects

### 3. **Camera Calibration**
- Requires camera focal length and sensor dimensions
- Can be calibrated using reference objects at known distances
- Automatically adjusts parameters based on calibration

## API Changes

### New Response Format
```json
{
  "objects": [
    {
      "classIndex": 0,
      "confidence": 0.95,
      "label": "person",
      "position": "center",
      "objectDistance": 2.5,        // Physical distance in meters
      "midasDistance": 0.8,         // Original MiDaS relative distance
      "estimatedHeight": 1.7,       // Estimated height in meters
      "centerX": 256.0,
      "centerY": 128.0,
      "boundingBox": { ... }
    }
  ],
  "imageDimensions": {
    "width": 512,
    "height": 384
  },
  "cameraCalibration": {
    "focalLengthMm": 4.25,
    "sensorWidthMm": 7.0
  }
}
```

### New Endpoints

#### 1. **Calibrate Camera** - `POST /calibrate`
Calibrate using a reference object at known distance.

**Parameters:**
- `file`: Image with reference object
- `reference_distance_m`: Known distance in meters (default: 2.0)
- `reference_object_label`: Object type (default: "person")

**Example:**
```bash
curl -X POST "http://localhost:8000/calibrate" \
  -F "file=@image.jpg" \
  -F "reference_distance_m=3.0" \
  -F "reference_object_label=person"
```

#### 2. **Get Calibration** - `GET /calibration`
Get current camera parameters.

**Response:**
```json
{
  "focalLengthMm": 4.25,
  "sensorWidthMm": 7.0,
  "referenceObjectHeightMm": 1700
}
```

## Configuration

### Camera Parameters
Edit these values in `server.py` for your specific camera:

```python
CAMERA_FOCAL_LENGTH_MM = 4.25  # iPhone 12/13 typical
SENSOR_WIDTH_MM = 7.0          # iPhone 12/13 sensor width
REFERENCE_OBJECT_HEIGHT_MM = 1700  # Average human height
```

### Object Height Database
The system includes height estimates for common objects:

- **People**: person (1700mm), man (1750mm), woman (1650mm), child (1200mm)
- **Vehicles**: car (1500mm), truck (3000mm), bus (3500mm)
- **Animals**: dog (600mm), cat (300mm), horse (1800mm)
- **Furniture**: chair (900mm), table (750mm), sofa (800mm)

## Calibration Process

### Step 1: Initial Setup
1. Set approximate camera parameters in the code
2. Test with known objects at known distances

### Step 2: Fine-tune Calibration
1. Take a photo of a person at exactly 2 meters
2. Call the calibration endpoint:
   ```bash
   curl -X POST "http://localhost:8000/calibrate" \
     -F "file=@person_at_2m.jpg" \
     -F "reference_distance_m=2.0" \
     -F "reference_object_label=person"
   ```

### Step 3: Verify Accuracy
1. Test with objects at different known distances
2. Adjust calibration if needed

## Accuracy Considerations

### Factors Affecting Accuracy
1. **Camera calibration quality** - More accurate parameters = better results
2. **Object height estimation** - Real-world object sizes vary
3. **Image quality** - Higher resolution = better bounding box detection
4. **Object orientation** - Objects should be roughly perpendicular to camera

### Expected Accuracy
- **Well-calibrated system**: ±10-20% accuracy
- **Typical range**: 0.5m to 20m
- **Best for**: People, vehicles, furniture
- **Challenging for**: Small objects, irregular shapes

## Troubleshooting

### Distance Seems Too Far/Close
1. Check camera focal length parameter
2. Recalibrate using a reference object
3. Verify object height estimates

### Inconsistent Results
1. Ensure objects are perpendicular to camera
2. Use higher resolution images
3. Check for camera shake or blur

### Objects Not Detected
1. Verify object is in the height database
2. Add custom height estimates for your use case
3. Check detection confidence thresholds

## Advanced Usage

### Custom Object Heights
Add new objects to the `estimate_object_height()` function:

```python
height_estimates = {
    "your_custom_object": 1000,  # Height in mm
    # ... existing objects
}
```

### Multiple Calibration Points
For better accuracy, calibrate with multiple reference distances and average the results.

### Stereo Vision (Future Enhancement)
For even better accuracy, consider implementing stereo vision with two cameras.

## Example Usage

```python
import requests

# Calibrate camera
with open('person_at_2m.jpg', 'rb') as f:
    response = requests.post(
        'http://localhost:8000/calibrate',
        files={'file': f},
        data={'reference_distance_m': 2.0, 'reference_object_label': 'person'}
    )
    print(response.json())

# Get distance measurements
with open('test_image.jpg', 'rb') as f:
    response = requests.post(
        'http://localhost:8000/infer',
        files={'file': f}
    )
    data = response.json()
    
    for obj in data['objects']:
        print(f"{obj['label']}: {obj['objectDistance']:.2f}m away")
```

## Migration from Old System

The old relative depth values are still available as `midasDistance` for backward compatibility. Update your client code to use `objectDistance` for physical measurements.
