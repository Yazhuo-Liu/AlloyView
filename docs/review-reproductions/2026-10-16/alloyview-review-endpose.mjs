// Archived review evidence for baseline 77b24ad; see docs/REPOSITORY_REVIEW_2026-10-16.md.
import {createCameraPath, planMovie} from '../../../src/render/camera-path.js';
const c=yaw=>({yaw,pitch:.3,roll:0,fov:.7,constrainUp:true,target:[0,0,0],pan:[0,0,0],distance:20,orthographicScale:8,projectionMode:'perspective'});
const path={...createCameraPath(),keyframes:[{time:0,camera:c(0),frame:null},{time:1.1,camera:c(1),frame:null}]};
const p=planMovie(path,{fps:24,frameCount:1});
console.log({duration:p.duration,frameTotal:p.frameTotal,includeEnd:p.includeEnd,lastTime:p.timeAt(p.frameTotal-1),lastYaw:p.cameraAt(p.frameTotal-1).yaw,expectedYaw:1});
