import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './ui/App'
import { CustomCursor } from './ui/CustomCursor'
import './ui/index.css'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <CustomCursor />
    <App />
  </React.StrictMode>
)
