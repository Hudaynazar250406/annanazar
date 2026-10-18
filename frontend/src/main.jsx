import React from 'react'
import { createRoot } from 'react-dom/client'
import App from './App.jsx'
import Notifications from './Notifications.jsx'
import Recorder from './Recorder.jsx'
import './styles.css'
import { installPhotoPicker } from './photoPicker.js'
import { installMobileLayout } from './mobileLayout.js'
const root=document.getElementById('root')
const photoCleanup=installPhotoPicker(root)
const mobileCleanup=installMobileLayout(root)
createRoot(root).render(<><App/><Notifications root={root}/><Recorder root={root}/></>)
if(import.meta.hot)import.meta.hot.dispose(()=>{photoCleanup();mobileCleanup()})
