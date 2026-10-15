import React from 'react'
import { createRoot } from 'react-dom/client'
import App from './App.jsx'
import './styles.css'
import { installPhotoPicker } from './photoPicker.js'
import { installMobileLayout } from './mobileLayout.js'

const root = document.getElementById('root')
const photoCleanup = installPhotoPicker(root)
const mobileCleanup = installMobileLayout(root)
createRoot(root).render(<App />)
if (import.meta.hot) import.meta.hot.dispose(() => { photoCleanup(); mobileCleanup() })
