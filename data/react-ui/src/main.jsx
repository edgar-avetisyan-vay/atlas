import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.jsx'
import './index.css'
import { SiteSourceProvider } from './context/SiteSourceContext.jsx'

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <SiteSourceProvider>
      <App />
    </SiteSourceProvider>
  </React.StrictMode>,
)
