import { createRoot } from 'react-dom/client'
import './styles.css'
import { App } from './App.js'

const rootElement = document.getElementById('root')
if (rootElement) createRoot(rootElement).render(<App />)
