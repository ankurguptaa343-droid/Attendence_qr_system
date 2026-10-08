#!/bin/bash
createdb attendance 2>/dev/null
npm install && npm run migrate && npm start
