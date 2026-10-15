import React from 'react'
import { createRoot } from 'react-dom/client'
import App from './App.jsx'
import './styles.css'
import { installPhotoPicker } from './photoPicker.js'

const root = document.getElementById('root')
const cleanup = installPhotoPicker(root)
createRoot(root).render(<App />)
if (import.meta.hot) import.meta.hot.dispose(cleanup)
